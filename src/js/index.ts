import type {
    WSOptions,
    WSHandler,
    WSContext,
    WSMetrics,
    ServerEvents,
    PubSubAdapter,
    HistoryEntry,
    ReconnectState,
    RoomConfig,
    SecurityConfig,
    CompressionConfig,
} from '../types/index.js';
import { loadNative, isNativeLoaded } from './native-loader.js';
import { createWSContext } from './ws-context.js';
import { RoomManager } from './room-manager.js';
import { MetricsCollector } from './utils/metrics.js';
import { TypedEmitter } from './event-emitter.js';
import { InternalEventBus, getEventBus } from './utils/events.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { JSSideRateLimiter, JSSideConnectionThrottler } from './middleware/rate-limit.js';
import { MessageBatcher, mergeCompressionConfig } from './middleware/compression.js';
import logger from 'ernest-logger';

// ── Re-exports ────────────────────────────────────────────────

export type {
    WSOptions,
    WSHandler,
    WSContext,
    WSMetrics,
    ServerEvents,
    ConnectionInfo,
    RoomConfig,
    SecurityConfig,
    CompressionConfig,
    PubSubAdapter,
    RedisPubSubConfig,
    AuthConfig,
    HistoryEntry,
    ReconnectState,
    RoomSender,
} from '../types/index.js';

export { RoomManager }       from './room-manager.js';
export { MetricsCollector }  from './utils/metrics.js';
export { TypedEmitter }      from './event-emitter.js';
export { loadNative, isNativeLoaded } from './native-loader.js';

// ── WebSocketServer ───────────────────────────────────────────

/**
 * Standalone WebSocket server backed by a native C++ uWebSockets core.
 */
export class WebSocketServer extends TypedEmitter<ServerEvents> {
    private native: ReturnType<typeof loadNative>;
    private options: WSOptions;
    private roomManager: RoomManager;
    private metricsCollector: MetricsCollector;
    private eventBus: InternalEventBus;
    private rateLimiter?: JSSideRateLimiter;
    private connectionThrottler?: JSSideConnectionThrottler;
    private messageBatcher?: MessageBatcher;
    private authMiddleware?: (
        headers: Record<string, string>,
        query: Record<string, string>,
    ) => Promise<Record<string, any> | null>;
    private connections = new Map<string, WSContext>();
    private pubSubAdapter?: PubSubAdapter;
    private compressionConfig: CompressionConfig;
    private started = false;

    // ── User-supplied lifecycle handlers ──────────────────────
    private _openHandler?:    (ctx: WSContext) => void | Promise<void>;
    private _messageHandler?: (ctx: WSContext, data: any) => void | Promise<void>;
    private _closeHandler?:   (ctx: WSContext, code: number, reason: string) => void | Promise<void>;
    private _drainHandler?:   (ctx: WSContext) => void | Promise<void>;

    constructor(options: WSOptions = {}) {
        super();
        this.options          = options;
        this.native           = loadNative();
        this.roomManager      = new RoomManager();
        this.metricsCollector = new MetricsCollector();
        this.eventBus         = getEventBus();
        this.compressionConfig = mergeCompressionConfig(options.compression);

        if (options.security) {
            this.rateLimiter          = new JSSideRateLimiter(options.security);
            this.connectionThrottler  = new JSSideConnectionThrottler(options.security);
        }

        if (options.security?.auth?.enabled) {
            this.authMiddleware = createAuthMiddleware(options.security);
        }

        if (options.batching) {
            this.messageBatcher = new MessageBatcher(this.native, options.batching);
        }

        if (options.pubSub) {
            this.pubSubAdapter = options.pubSub;
            this.setupPubSub();
        }

        // Wire C++ TSFN callbacks → JS handlers
        this.wireNativeCallbacks();
    }

    // ── Lifecycle handler registration (fluent API) ───────────

    onOpen(fn: (ctx: WSContext) => void | Promise<void>): this {
        this._openHandler = fn;
        return this;
    }

    onMessage(fn: (ctx: WSContext, data: any) => void | Promise<void>): this {
        this._messageHandler = fn;
        return this;
    }

    onClose(fn: (ctx: WSContext, code: number, reason: string) => void | Promise<void>): this {
        this._closeHandler = fn;
        return this;
    }

    onDrain(fn: (ctx: WSContext) => void | Promise<void>): this {
        this._drainHandler = fn;
        return this;
    }

    // ── Server start / stop ───────────────────────────────────

    start(): this {
        const host = this.options.host ?? '0.0.0.0';
        const port = this.options.port ?? 3001;
        this.initialize(host, port, this.options.tls);
        return this;
    }

    initialize(host: string, port: number, tls?: { cert: string; key: string }): void {
        if (this.started) return;

        const config: Record<string, any> = {
            host,
            port,
            maxPayloadBytes:    this.options.maxPayload     ?? 1048576,
            idleTimeout:        this.options.idleTimeout    ?? 120,
            compressionEnabled: this.compressionConfig.enabled,
            compressionLevel:   this.compressionConfig.level,
            highWaterMark:      this.options.highWaterMark  ?? 1048576,
            historyEnabled:     this.options.history !== false && this.options.history !== undefined,
            maxEntriesPerRoom:  typeof this.options.history === 'object'
                                    ? this.options.history.maxEntriesPerRoom
                                    : 100,
            security: this.options.security
                ? {
                      maxMessagesPerMinute: this.options.security.maxMessagesPerMinute ?? 60,
                      maxPayloadBytes:      this.options.security.maxPayloadBytes      ?? 1048576,
                      maxConnectionsPerIP:  this.options.security.maxConnectionsPerIP  ?? 10,
                  }
                : undefined,

            // ── C++ → JS callbacks (ThreadSafeFunction targets) ──
            onOpen:    (data: { connectionId: string; ip: string; path: string }) => {
                this.handleNativeOpen(data.connectionId, data.ip, data.path);
            },
            onMessage: (data: { connectionId: string; data: string }) => {
                this.handleNativeMessage(data.connectionId, data.data);
            },
            onClose:   (data: { connectionId: string; code: number; reason: string }) => {
                this.handleNativeClose(data.connectionId, data.code, data.reason);
            },
            onDrain:   (data: { connectionId: string }) => {
                this.handleNativeDrain(data.connectionId);
            },
        };

        if (tls) {
            config.tlsEnabled = true;
            config.certPath   = tls.cert;
            config.keyPath    = tls.key;
        }

        // ── Step 1: configure and start the native server ──
        this.native.configure(config);
        this.native.start();
        this.started = true;

        // ── Step 2: wire join confirmation AFTER configure() ──
        // This prevents registerCallbacks() from releasing it.
        if (typeof (this.native as any).setOnJoinConfirmed === 'function') {
            (this.native as any).setOnJoinConfirmed(
                ({ connectionId, room }: { connectionId: string; room: string }) => {
                    this.roomManager._handleJoinConfirm(connectionId, room);
                }
            );
        }

        this.messageBatcher?.start();
        this.metricsCollector.start();

        logger.success(
            `WebSocket server started on ${host}:${port} ` +
            `(native: ${isNativeLoaded() ? 'C++' : 'JS mock'})`
        );
        this.emit('serverStarted', { host, port });
    }

    async shutdown(): Promise<void> {
        if (!this.started) return;
        this.started = false;

        this.messageBatcher?.stop();
        this.metricsCollector.stop();
        this.rateLimiter?.destroy();
        this.connectionThrottler?.destroy();

        // Flush all pending joins and clean up RoomManager
        this.roomManager.destroy();

        for (const [, ctx] of this.connections) {
            try { ctx.close(1001, 'Server shutting down'); } catch { /* already closed */ }
        }
        this.connections.clear();

        this.native.stop();

        if (this.pubSubAdapter?.destroy) {
            await this.pubSubAdapter.destroy();
        }

        logger.info('WebSocket server shut down gracefully');
        this.emit('serverStopped', { reason: 'graceful_shutdown' });
    }

    // ── Native callback handlers ──────────────────────────────

    private handleNativeOpen(connectionId: string, ip: string, _path: string): void {
        if (this.connectionThrottler && !this.connectionThrottler.allow(ip)) {
            logger.security(`Connection rejected from ${ip}: too many connections`);
            this.native.disconnect(connectionId);
            return;
        }

        const wsCtx = createWSContext(connectionId, ip, this.native, this.options, this.roomManager);
        this.connections.set(connectionId, wsCtx);

        this.eventBus.emit('connectionOpened', { connectionId, ip });
        this.emit('connection', { connectionId, ip });
        logger.info(`[WS] Connection opened: ${connectionId} (IP: ${ip})`);

        if (this._openHandler) {
            Promise.resolve(this._openHandler(wsCtx)).catch(err => {
                logger.error(`Error in open handler: ${err}`);
            });
        }
    }

    private handleNativeMessage(connectionId: string, rawData: string): void {
        const ctx = this.connections.get(connectionId);
        if (!ctx) return;

        const dataBytes = Buffer.byteLength(rawData);

        if (this.rateLimiter && !this.rateLimiter.check(connectionId, dataBytes)) {
            this.eventBus.emit('rateLimitHit', {
                connectionId,
                droppedCount: this.rateLimiter.getDroppedCount(connectionId),
            });
            return;
        }

        const parsed = tryParse(rawData);

        this.eventBus.emit('messageReceived', { connectionId, data: rawData, bytes: dataBytes });
        this.emit('message', { connectionId, data: parsed });

        if (this._messageHandler) {
            // Await the handler so ctx.join() can wait for confirmation
            Promise.resolve(this._messageHandler(ctx, parsed)).catch(err => {
                logger.error(`Error in message handler: ${err}`);
            });
        }
    }

    private handleNativeClose(connectionId: string, code: number, reason: string): void {
        const ctx = this.connections.get(connectionId);
        if (!ctx) return;

        // ── Clean up any pending joins for this connection ──────
        this.roomManager.cancelPendingJoins(connectionId);

        ctx.leaveAll();
        this.connections.delete(connectionId);
        this.rateLimiter?.removeConnection(connectionId);
        this.connectionThrottler?.remove(ctx.ip);

        this.eventBus.emit('connectionClosed', { connectionId, code, reason });
        this.emit('disconnection', { connectionId, code, reason });
        logger.info(`[WS] Connection closed: ${connectionId} (code: ${code}, reason: ${reason})`);

        if (this._closeHandler) {
            Promise.resolve(this._closeHandler(ctx, code, reason)).catch(err => {
                logger.error(`Error in close handler: ${err}`);
            });
        }
    }

    private handleNativeDrain(connectionId: string): void {
        const ctx = this.connections.get(connectionId);
        if (!ctx) return;

        if (this._drainHandler) {
            Promise.resolve(this._drainHandler(ctx)).catch(err => {
                logger.error(`Error in drain handler: ${err}`);
            });
        }
    }

    // ── Wire callbacks (no‑op now – setOnJoinConfirmed is wired after configure) ──
    private wireNativeCallbacks(): void {
        // Nothing to do here – the confirmation callback is set in initialize() after configure.
    }

    // ── Public API ────────────────────────────────────────────

    getMetrics(): WSMetrics {
        return this.metricsCollector.snapshot();
    }

    getConnectionCount(): number {
        return this.connections.size;
    }

    getHistory(room: string, sinceTimestamp?: number): HistoryEntry[] {
        return this.native.getHistory(room, sinceTimestamp) as HistoryEntry[];
    }

    getReconnectState(userId: string): ReconnectState | null {
        for (const [, ctx] of this.connections) {
            if (ctx.userId === userId) {
                return {
                    lastSeenMessageId:  `last-${Date.now()}`,
                    lastSeenTimestamp:  Date.now(),
                    rooms:              Array.from(ctx.rooms),
                    userId,
                };
            }
        }
        return null;
    }

    getRooms(): RoomManager {
        return this.roomManager;
    }

    getMetricsCollector(): MetricsCollector {
        return this.metricsCollector;
    }

    getEventBus(): InternalEventBus {
        return this.eventBus;
    }

    async authenticateUpgrade(
        headers: Record<string, string>,
        query: Record<string, string>,
    ): Promise<Record<string, any> | null> {
        if (!this.authMiddleware) return {};
        return this.authMiddleware(headers, query);
    }

    // ── Internal helpers ──────────────────────────────────────

    private setupPubSub(): void {
        if (!this.pubSubAdapter) return;
        this.pubSubAdapter.onMessage?.((room: string, message: string) => {
            this.native.broadcastToRoom(room, message);
            this.eventBus.emit('roomBroadcast', { room, message, recipientCount: 0 });
        });
        logger.info('Pub/Sub adapter connected for horizontal scaling');
    }
}

// ── Plugin / Factory function ─────────────────────────────────

export function ws<T extends Record<string, any> = Record<string, any>>(
    options: WSOptions<T> = {}
): WebSocketServer {
    return new WebSocketServer(options as WSOptions);
}

// ── Utility ───────────────────────────────────────────────────

function tryParse(str: string): any {
    try { return JSON.parse(str); } catch { return str; }
}

// ── Default export ────────────────────────────────────────────

export default ws;
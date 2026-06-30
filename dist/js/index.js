import { loadNative, isNativeLoaded } from './native-loader.js';
import { createWSContext } from './ws-context.js';
import { RoomManager } from './room-manager.js';
import { MetricsCollector } from './utils/metrics.js';
import { TypedEmitter } from './event-emitter.js';
import { getEventBus } from './utils/events.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { JSSideRateLimiter, JSSideConnectionThrottler } from './middleware/rate-limit.js';
import { MessageBatcher, mergeCompressionConfig } from './middleware/compression.js';
import logger from 'ernest-logger';
export { RoomManager } from './room-manager.js';
export { MetricsCollector } from './utils/metrics.js';
export { TypedEmitter } from './event-emitter.js';
export { loadNative, isNativeLoaded } from './native-loader.js';
// ── WebSocketServer ───────────────────────────────────────────
/**
 * Standalone WebSocket server backed by a native C++ uWebSockets core.
 *
 * cppws owns the sockets — no Bun/Node/Deno transport API is used.
 * Every runtime receives identical behaviour.
 *
 * Usage:
 *   const server = new WebSocketServer({ port: 3001, rooms: true })
 *   server.onOpen(ctx => ctx.join('general'))
 *   server.onMessage((ctx, data) => ctx.to('general').send(data))
 *   server.onClose((ctx, code) => console.log('closed', code))
 *   server.start()
 */
export class WebSocketServer extends TypedEmitter {
    native;
    options;
    roomManager;
    metricsCollector;
    eventBus;
    rateLimiter;
    connectionThrottler;
    messageBatcher;
    authMiddleware;
    connections = new Map();
    pubSubAdapter;
    compressionConfig;
    started = false;
    // ── User-supplied lifecycle handlers ──────────────────────
    _openHandler;
    _messageHandler;
    _closeHandler;
    _drainHandler;
    constructor(options = {}) {
        super();
        this.options = options;
        this.native = loadNative();
        this.roomManager = new RoomManager();
        this.metricsCollector = new MetricsCollector();
        this.eventBus = getEventBus();
        this.compressionConfig = mergeCompressionConfig(options.compression);
        if (options.security) {
            this.rateLimiter = new JSSideRateLimiter(options.security);
            this.connectionThrottler = new JSSideConnectionThrottler(options.security);
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
        // These are called by the C++ background thread via ThreadSafeFunction
        // whenever a connection opens, a message arrives, or a connection closes.
        this.wireNativeCallbacks();
    }
    // ── Lifecycle handler registration (fluent API) ───────────
    onOpen(fn) {
        this._openHandler = fn;
        return this;
    }
    onMessage(fn) {
        this._messageHandler = fn;
        return this;
    }
    onClose(fn) {
        this._closeHandler = fn;
        return this;
    }
    onDrain(fn) {
        this._drainHandler = fn;
        return this;
    }
    // ── Server start / stop ───────────────────────────────────
    /**
     * Start the C++ uWebSockets server.
     * The server listens on the port specified in options (default 3001).
     */
    start() {
        const host = this.options.host ?? '0.0.0.0';
        const port = this.options.port ?? 3001;
        this.initialize(host, port, this.options.tls);
        return this;
    }
    /**
     * Internal initializer — separated so tests can call it directly.
     */
    initialize(host, port, tls) {
        if (this.started)
            return;
        const config = {
            host,
            port,
            maxPayloadBytes: this.options.maxPayload ?? 1048576,
            idleTimeout: this.options.idleTimeout ?? 120,
            compressionEnabled: this.compressionConfig.enabled,
            compressionLevel: this.compressionConfig.level,
            highWaterMark: this.options.highWaterMark ?? 1048576,
            historyEnabled: this.options.history !== false && this.options.history !== undefined,
            maxEntriesPerRoom: typeof this.options.history === 'object'
                ? this.options.history.maxEntriesPerRoom
                : 100,
            security: this.options.security
                ? {
                    maxMessagesPerMinute: this.options.security.maxMessagesPerMinute ?? 60,
                    maxPayloadBytes: this.options.security.maxPayloadBytes ?? 1048576,
                    maxConnectionsPerIP: this.options.security.maxConnectionsPerIP ?? 10,
                }
                : undefined,
            // ── C++ → JS callbacks (ThreadSafeFunction targets) ──
            onOpen: (data) => {
                this.handleNativeOpen(data.connectionId, data.ip, data.path);
            },
            onMessage: (data) => {
                this.handleNativeMessage(data.connectionId, data.data);
            },
            onClose: (data) => {
                this.handleNativeClose(data.connectionId, data.code, data.reason);
            },
            onDrain: (data) => {
                this.handleNativeDrain(data.connectionId);
            },
        };
        if (tls) {
            config.tlsEnabled = true;
            config.certPath = tls.cert;
            config.keyPath = tls.key;
        }
        this.native.configure(config);
        this.native.start();
        this.started = true;
        this.messageBatcher?.start();
        this.metricsCollector.start();
        logger.success(`WebSocket server started on ${host}:${port} ` +
            `(native: ${isNativeLoaded() ? 'C++' : 'JS mock'})`);
        this.emit('serverStarted', { host, port });
    }
    /**
     * Gracefully shut down the server.
     */
    async shutdown() {
        if (!this.started)
            return;
        this.started = false;
        this.messageBatcher?.stop();
        this.metricsCollector.stop();
        this.rateLimiter?.destroy();
        this.connectionThrottler?.destroy();
        for (const [, ctx] of this.connections) {
            try {
                ctx.close(1001, 'Server shutting down');
            }
            catch { /* already closed */ }
        }
        this.connections.clear();
        this.native.stop();
        if (this.pubSubAdapter?.destroy) {
            await this.pubSubAdapter.destroy();
        }
        logger.info('WebSocket server shut down gracefully');
        this.emit('serverStopped', { reason: 'graceful_shutdown' });
    }
    // ── Native callback handlers (called from C++ via TSFN) ──
    /**
     * Called by C++ when a new WebSocket connection is fully open.
     * At this point the C++ layer owns the socket — we just create
     * the JS-side context and call the user's open handler.
     */
    handleNativeOpen(connectionId, ip, _path) {
        // Connection throttling (JS-side double-check)
        if (this.connectionThrottler && !this.connectionThrottler.allow(ip)) {
            logger.security(`Connection rejected from ${ip}: too many connections`);
            this.native.disconnect(connectionId);
            return;
        }
        // Build WSContext — all transport calls go to native directly
        const wsCtx = createWSContext(connectionId, ip, this.native, this.options, this.roomManager);
        this.connections.set(connectionId, wsCtx);
        this.eventBus.emit('connectionOpened', { connectionId, ip });
        this.emit('connection', { connectionId, ip });
        logger.info(`[WS] Connection opened: ${connectionId} (IP: ${ip})`);
        // Call user open handler
        if (this._openHandler) {
            Promise.resolve(this._openHandler(wsCtx)).catch(err => {
                logger.error(`Error in open handler: ${err}`);
            });
        }
    }
    /**
     * Called by C++ when a message arrives from a connection.
     */
    handleNativeMessage(connectionId, rawData) {
        const ctx = this.connections.get(connectionId);
        if (!ctx)
            return;
        const dataBytes = Buffer.byteLength(rawData);
        // JS-side rate limiting
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
            Promise.resolve(this._messageHandler(ctx, parsed)).catch(err => {
                logger.error(`Error in message handler: ${err}`);
            });
        }
    }
    /**
     * Called by C++ when a connection closes.
     */
    handleNativeClose(connectionId, code, reason) {
        const ctx = this.connections.get(connectionId);
        if (!ctx)
            return;
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
    /**
     * Called by C++ when backpressure drains on a connection.
     */
    handleNativeDrain(connectionId) {
        const ctx = this.connections.get(connectionId);
        if (!ctx)
            return;
        if (this._drainHandler) {
            Promise.resolve(this._drainHandler(ctx)).catch(err => {
                logger.error(`Error in drain handler: ${err}`);
            });
        }
    }
    // ── Wire callbacks into native configure ──────────────────
    /**
     * Called once in the constructor to set up TSFN callbacks.
     * The callbacks are passed again in initialize() with the full config,
     * but we set them here too so the mock works in tests without calling start().
     */
    wireNativeCallbacks() {
        // No-op for now: callbacks are wired inside initialize() via configure().
        // If the JS mock needs them earlier (unit tests), they're set via configure()
        // when the test calls native.configure() manually.
    }
    // ── Public API ────────────────────────────────────────────
    getMetrics() {
        return this.metricsCollector.snapshot();
    }
    getConnectionCount() {
        return this.connections.size;
    }
    getHistory(room, sinceTimestamp) {
        return this.native.getHistory(room, sinceTimestamp);
    }
    getReconnectState(userId) {
        for (const [, ctx] of this.connections) {
            if (ctx.userId === userId) {
                return {
                    lastSeenMessageId: `last-${Date.now()}`,
                    lastSeenTimestamp: Date.now(),
                    rooms: Array.from(ctx.rooms),
                    userId,
                };
            }
        }
        return null;
    }
    getRooms() {
        return this.roomManager;
    }
    getMetricsCollector() {
        return this.metricsCollector;
    }
    getEventBus() {
        return this.eventBus;
    }
    // ── Auth helper (used by http upgrade hooks if needed) ────
    async authenticateUpgrade(headers, query) {
        if (!this.authMiddleware)
            return {};
        return this.authMiddleware(headers, query);
    }
    // ── Internal helpers ──────────────────────────────────────
    setupPubSub() {
        if (!this.pubSubAdapter)
            return;
        this.pubSubAdapter.onMessage?.((room, message) => {
            this.native.broadcastToRoom(room, message);
            this.eventBus.emit('roomBroadcast', { room, message, recipientCount: 0 });
        });
        logger.info('Pub/Sub adapter connected for horizontal scaling');
    }
}
// ── Plugin / Factory function ─────────────────────────────────
/**
 * Create a cppws WebSocket server instance.
 *
 * Returns a WebSocketServer — call .onOpen(), .onMessage(), .onClose(),
 * then .start() to launch the C++ uWebSockets server.
 *
 * Works alongside ANY HTTP framework (Elysia, Express, Hono, Fastify…)
 * or completely standalone. Runtime agnostic: Bun, Node.js, Deno.
 *
 * @example
 * ```typescript
 * import { ws } from 'cppws'
 *
 * ws({ port: 3001, rooms: true })
 *   .onOpen(ctx => ctx.join('general'))
 *   .onMessage((ctx, data) => ctx.to('general').send(data))
 *   .onClose((ctx, code) => console.log('closed', code))
 *   .start()
 * ```
 */
export function ws(options = {}) {
    return new WebSocketServer(options);
}
// ── Utility ───────────────────────────────────────────────────
function tryParse(str) {
    try {
        return JSON.parse(str);
    }
    catch {
        return str;
    }
}
// ── Default export ────────────────────────────────────────────
export default ws;
//# sourceMappingURL=index.js.map
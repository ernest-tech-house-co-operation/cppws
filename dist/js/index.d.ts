import type { WSOptions, WSContext, WSMetrics, ServerEvents, HistoryEntry, ReconnectState } from '../types/index.js';
import { RoomManager } from './room-manager.js';
import { MetricsCollector } from './utils/metrics.js';
import { TypedEmitter } from './event-emitter.js';
import { InternalEventBus } from './utils/events.js';
export type { WSOptions, WSHandler, WSContext, WSMetrics, ServerEvents, ConnectionInfo, RoomConfig, SecurityConfig, CompressionConfig, PubSubAdapter, RedisPubSubConfig, AuthConfig, HistoryEntry, ReconnectState, RoomSender, } from '../types/index.js';
export { RoomManager } from './room-manager.js';
export { MetricsCollector } from './utils/metrics.js';
export { TypedEmitter } from './event-emitter.js';
export { loadNative, isNativeLoaded } from './native-loader.js';
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
export declare class WebSocketServer extends TypedEmitter<ServerEvents> {
    private native;
    private options;
    private roomManager;
    private metricsCollector;
    private eventBus;
    private rateLimiter?;
    private connectionThrottler?;
    private messageBatcher?;
    private authMiddleware?;
    private connections;
    private pubSubAdapter?;
    private compressionConfig;
    private started;
    private _openHandler?;
    private _messageHandler?;
    private _closeHandler?;
    private _drainHandler?;
    constructor(options?: WSOptions);
    onOpen(fn: (ctx: WSContext) => void | Promise<void>): this;
    onMessage(fn: (ctx: WSContext, data: any) => void | Promise<void>): this;
    onClose(fn: (ctx: WSContext, code: number, reason: string) => void | Promise<void>): this;
    onDrain(fn: (ctx: WSContext) => void | Promise<void>): this;
    /**
     * Start the C++ uWebSockets server.
     * The server listens on the port specified in options (default 3001).
     */
    start(): this;
    /**
     * Internal initializer — separated so tests can call it directly.
     */
    initialize(host: string, port: number, tls?: {
        cert: string;
        key: string;
    }): void;
    /**
     * Gracefully shut down the server.
     */
    shutdown(): Promise<void>;
    /**
     * Called by C++ when a new WebSocket connection is fully open.
     * At this point the C++ layer owns the socket — we just create
     * the JS-side context and call the user's open handler.
     */
    private handleNativeOpen;
    /**
     * Called by C++ when a message arrives from a connection.
     */
    private handleNativeMessage;
    /**
     * Called by C++ when a connection closes.
     */
    private handleNativeClose;
    /**
     * Called by C++ when backpressure drains on a connection.
     */
    private handleNativeDrain;
    /**
     * Called once in the constructor to set up TSFN callbacks.
     * The callbacks are passed again in initialize() with the full config,
     * but we set them here too so the mock works in tests without calling start().
     */
    private wireNativeCallbacks;
    getMetrics(): WSMetrics;
    getConnectionCount(): number;
    getHistory(room: string, sinceTimestamp?: number): HistoryEntry[];
    getReconnectState(userId: string): ReconnectState | null;
    getRooms(): RoomManager;
    getMetricsCollector(): MetricsCollector;
    getEventBus(): InternalEventBus;
    authenticateUpgrade(headers: Record<string, string>, query: Record<string, string>): Promise<Record<string, any> | null>;
    private setupPubSub;
}
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
export declare function ws<T extends Record<string, any> = Record<string, any>>(options?: WSOptions<T>): WebSocketServer;
export default ws;
//# sourceMappingURL=index.d.ts.map
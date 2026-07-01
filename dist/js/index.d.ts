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
    private pendingJoins;
    constructor(options?: WSOptions);
    onOpen(fn: (ctx: WSContext) => void | Promise<void>): this;
    onMessage(fn: (ctx: WSContext, data: any) => void | Promise<void>): this;
    onClose(fn: (ctx: WSContext, code: number, reason: string) => void | Promise<void>): this;
    onDrain(fn: (ctx: WSContext) => void | Promise<void>): this;
    start(): this;
    initialize(host: string, port: number, tls?: {
        cert: string;
        key: string;
    }): void;
    shutdown(): Promise<void>;
    private handleNativeOpen;
    private handleNativeMessage;
    private handleNativeClose;
    private handleNativeDrain;
    private wireNativeCallbacks;
    private joinRoom;
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
export declare function ws<T extends Record<string, any> = Record<string, any>>(options?: WSOptions<T>): WebSocketServer;
export default ws;
//# sourceMappingURL=index.d.ts.map
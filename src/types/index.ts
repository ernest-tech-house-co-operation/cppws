// ── Connection Info ────────────────────────────────────────────────

export interface ConnectionInfo {
    id: string;
    ip: string;
    rooms: string[];
    userId?: string;
    connectedAt: number;
    lastSeen: number;
    messagesReceived: number;
    messagesSent: number;
    bytesReceived: number;
    bytesSent: number;
}

// ── Room Config ───────────────────────────────────────────────────

export interface RoomConfig {
    /** Whether room management is enabled (default: true) */
    enabled?: boolean;
    /** Maximum number of rooms a single connection can join (default: 50) */
    maxRoomsPerConnection?: number;
    /** Maximum connections in a single room (default: unlimited) */
    maxConnectionsPerRoom?: number;
}

// ── Security Config ───────────────────────────────────────────────

export interface SecurityConfig {
    /** Per-connection rate limit: max messages per minute (default: 60) */
    maxMessagesPerMinute?: number;
    /** Maximum payload size in bytes (default: 1048576 = 1MB) */
    maxPayloadBytes?: number;
    /** Maximum concurrent connections per IP address (default: 10) */
    maxConnectionsPerIP?: number;
    /** Authentication configuration */
    auth?: AuthConfig;
}

export interface AuthConfig {
    /** Enable authentication (default: false) */
    enabled: boolean;
    /**
     * Where to look for the auth token during the HTTP upgrade handshake.
     * 'query' = ?token=xxx in the URL
     * 'header' = Authorization: Bearer xxx header
     * 'cookie' = a specific cookie name
     */
    source?: 'query' | 'header' | 'cookie';
    /** The query parameter or cookie name to check (default: 'token') */
    fieldName?: string;
    /**
     * Validation function. Receives the raw token string and must return
     * a decoded user object or null/undefined if invalid.
     */
    validate?: (token: string) => Record<string, any> | null | Promise<Record<string, any> | null>;
    /**
     * Custom JWT secret for built-in JWT verification.
     * If set, the plugin uses a simple HMAC-SHA256 check internally.
     */
    secret?: string;
}

// ── Compression Config ────────────────────────────────────────────

export interface CompressionConfig {
    /** Enable permessage-deflate compression (default: false) */
    enabled?: boolean;
    /** Compression level 0-9 (default: 3) */
    level?: number;
    /** Minimum message size in bytes to compress (default: 1024) */
    threshold?: number;
}

// ── Pub/Sub Adapter (Horizontal Scaling) ─────────────────────────

export interface PubSubAdapter {
    /** Subscribe to a room/channel */
    subscribe(room: string): void | Promise<void>;
    /** Unsubscribe from a room/channel */
    unsubscribe(room: string): void | Promise<void>;
    /** Publish a message to a room/channel */
    publish(room: string, message: string): void | Promise<void>;
    /** Handle incoming messages from other instances */
    onMessage?(handler: (room: string, message: string) => void): void | Promise<void>;
    /** Gracefully shut down the adapter */
    destroy?(): void | Promise<void>;
}

// ── Redis Pub/Sub Adapter ─────────────────────────────────────────

export interface RedisPubSubConfig {
    /** Redis connection URL or config object */
    url?: string;
    /** Redis host (default: '127.0.0.1') */
    host?: string;
    /** Redis port (default: 6379) */
    port?: number;
    /** Redis password */
    password?: string;
    /** Redis DB number (default: 0) */
    db?: number;
    /** Key prefix for pub/sub channels (default: 'elysiajs:ws:') */
    keyPrefix?: string;
}

// ── Reconnection State ────────────────────────────────────────────

export interface ReconnectState {
    /** The last message/event ID the client acknowledged */
    lastSeenMessageId: string;
    /** Timestamp of the last received message */
    lastSeenTimestamp: number;
    /** The rooms the client was in before disconnecting */
    rooms: string[];
    /** The user ID (if authenticated) */
    userId?: string;
}

// ── History Entry ─────────────────────────────────────────────────

export interface HistoryEntry {
    room: string;
    message: string;
    timestamp: number;
    messageId: string;
}

// ── WS Handler Types ──────────────────────────────────────────────

export interface WSHandler<T extends Record<string, any> = Record<string, any>> {
    /** Called when the HTTP upgrade request comes in. Return false to reject. */
    upgrade?(ctx: any): boolean | Promise<boolean>;
    /** Called when the WebSocket connection is fully opened. */
    open?(ws: WSContext<T>): void | Promise<void>;
    /** Called when a message is received. */
    message?(ws: WSContext<T>, data: any): void | Promise<void>;
    /** Called when the connection is closed. */
    close?(ws: WSContext<T>, code: number, reason: string): void | Promise<void>;
    /** Called when the socket's write buffer is drained (backpressure cleared). */
    drain?(ws: WSContext<T>): void | Promise<void>;
    /** Called when a ping is received. */
    ping?(ws: WSContext<T>, data?: Buffer): void;
    /** Called when a pong is received. */
    pong?(ws: WSContext<T>, data?: Buffer): void;
}

// ── WS Context (Developer-Facing) ─────────────────────────────────

export interface WSContext<T extends Record<string, any> = Record<string, any>> {
    /** Unique connection ID */
    id: string;
    /** The user ID (if authenticated) */
    userId?: string;
    /** Client IP address */
    ip: string;
    /** Rooms this connection is currently in */
    rooms: Set<string>;

    // ── Room Operations ──────────────────────
    /** Join a room */
    join(room: string): WSContext<T>;
    /** Leave a room */
    leave(room: string): WSContext<T>;
    /** Leave all rooms */
    leaveAll(): WSContext<T>;

    // ── Messaging ────────────────────────────
    /** Send a message to this specific connection */
    send(data: any): WSContext<T>;
    /** Send a typed event (for the typed emitter pattern) */
    emit<K extends keyof T & string>(event: K, data: T[K]): WSContext<T>;
    /** Target a room for broadcast — returns a sender object */
    to(room: string): RoomSender<T>;
    /** Send a private message to a specific user (resolves via user-to-connection map) */
    privatelySend(userId: string, event: string, data: any): void;

    // ── Connection Control ───────────────────
    /** Close this connection */
    close(code?: number, reason?: string): void;
    /** Get live connection info and stats */
    getInfo(): ConnectionInfo;

    // ── Elysia Context Injection ─────────────
    /** Shared application store */
    store: any;
    /** HTTP headers from the upgrade request */
    headers: Record<string, string>;
    /** Parsed query parameters from the upgrade URL */
    query: Record<string, string>;
    /** Cookie jar (if Elysia cookie plugin is used) */
    cookie?: any;
    /** Decoded JWT/user payload (if authenticated) */
    jwt?: any;
    /** The raw Elysia context from the HTTP upgrade */
    request?: any;

    // ── Internal ─────────────────────────────
    /** @internal */
    _nativeRef: any;
    /** @internal */
    _server: any;
}

export interface RoomSender<T extends Record<string, any> = Record<string, any>> {
    send(data: any): void;
    emit<K extends keyof T & string>(event: K, data: T[K]): void;
}

// ── Main Plugin Options ───────────────────────────────────────────

export interface WSOptions<T extends Record<string, any> = Record<string, any>> {
    /** Enable room/pub-sub management */
    rooms?: boolean | RoomConfig;
    /** Security configuration (rate limiting, payload size, auth) */
    security?: SecurityConfig;
    /** Compression settings */
    compression?: CompressionConfig;
    /** Pub/Sub adapter for horizontal scaling across multiple server instances */
    pubSub?: PubSubAdapter;
    /** Idle timeout in seconds — closes zombie connections (default: 120) */
    idleTimeout?: number;
    /** Max payload size in bytes (default: 1048576 = 1MB) */
    maxPayload?: number;
    /** Backpressure high water mark in bytes (default: 1048576 = 1MB) */
    highWaterMark?: number;
    /** Enable broadcast history / event sourcing for message replay */
    history?: boolean | { maxEntriesPerRoom?: number };
    /** Enable SSE fallback when WebSocket upgrade is not supported */
    sseFallback?: boolean;
    /** Enable message batching (coalesce sends into fewer TCP packets) */
    batching?: boolean | { maxBatchSize?: number; flushInterval?: number };
    /** Logger instance (defaults to ernest-logger) */
    logger?: any;
    /**
     * Custom user ID extractor: receives the Elysia upgrade context and
     * should return a user ID string or undefined.
     */
    extractUserId?: (ctx: any) => string | undefined | Promise<string | undefined>;
    /** Host to bind to (default: '0.0.0.0') */
    host?: string;
    /** Port to bind to (default: auto-selected by Elysia) */
    port?: number;
    /** Enable TLS */
    tls?: { cert: string; key: string };
}

// ── Server Events (for typed emitter pattern) ─────────────────────

export interface ServerEvents {
    connection: { connectionId: string; ip: string };
    disconnection: { connectionId: string; code: number; reason: string };
    message: { connectionId: string; data: any };
    error: { connectionId?: string; error: Error };
    roomJoin: { connectionId: string; room: string };
    roomLeave: { connectionId: string; room: string };
    roomBroadcast: { room: string; message: string };
    serverStarted: { host: string; port: number };
    serverStopped: { reason: string };
}
export type { WSMetrics } from '../js/utils/metrics.js';
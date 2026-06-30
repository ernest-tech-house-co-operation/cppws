/**
 * types/index.d.ts — Master type declarations for elysiajscppws.
 *
 * Everything that consumers may import is declared here.
 */

// ── Re-exports from JS modules ───────────────────────────────────────────

export {
  type WSContext,
  type ConnectionInfo,
  type WSContextInit,
  type RoomProxy,
  type NativeServerLike,
} from '../js/ws-context';

export {
  type Emitter,
  type EventMap,
} from '../js/event-emitter';

export {
  type WSMetrics,
  type NativeMetricsServer,
} from '../js/utils/metrics';

export {
  type ServerEvents,
  type ConnectionOpenedData,
  type ConnectionClosedData,
  type MessageReceivedData,
  type RoomEventData,
  type ErrorData,
  type ShutdownData,
  type DrainData,
  type ServerStartedData,
  type ServerStoppedData,
} from '../js/utils/events';

export {
  type NativeRoomServer,
} from '../js/room-manager';

// ── Room configuration ───────────────────────────────────────────────────

/** Configuration for the built-in room / pub-sub system. */
export interface RoomConfig {
  /** Maximum number of rooms allowed (default: 10 000). */
  maxRooms?: number;
  /** Maximum members per room (default: unlimited). */
  maxMembersPerRoom?: number;
  /** Automatically remove empty rooms after this many ms (0 = keep forever). */
  emptyRoomTtlMs?: number;
}

// ── Security configuration ───────────────────────────────────────────────

/** Security-related configuration. */
export interface SecurityConfig {
  /** Maximum messages per connection per minute (default: 120). */
  rateLimitMaxPerMinute?: number;
  /** Maximum payload size in bytes (overrides the top-level `maxPayload`). */
  maxPayloadBytes?: number;
  /** Maximum concurrent connections per IP address (default: 20). */
  maxConnectionsPerIP?: number;
  /** Origin checking — if set, only these origins are allowed. */
  allowedOrigins?: string[];
  /** Require a valid JWT in the upgrade request. */
  requireAuth?: boolean;
  /** Custom authentication function. Return `true` to allow. */
  authenticate?: (request: any) => boolean | Promise<boolean>;
}

// ── Compression configuration ────────────────────────────────────────────

/** Permessage-deflate / uWS shared-compression settings. */
export interface CompressionConfig {
  /** Enable compression (default: false). */
  enabled?: boolean;
  /** Compression level 0-9 (default: 3). */
  level?: number;
  /** Minimum message size in bytes before compression is applied (default: 256). */
  threshold?: number;
}

// ── Pub/Sub adapter (horizontal scaling) ─────────────────────────────────

/**
 * Adapter interface for cross-instance message distribution.
 *
 * Implementations can back onto Redis, NATS, Kafka, etc.
 * The plugin calls these methods; the adapter handles transport.
 */
export interface PubSubAdapter {
  /** Called once when the server starts. */
  connect(): Promise<void>;
  /** Called once when the server stops. */
  disconnect(): Promise<void>;
  /** Subscribe to room broadcast messages. */
  subscribe(room: string, handler: (message: string) => void): Promise<void>;
  /** Unsubscribe from room broadcast messages. */
  unsubscribe(room: string): Promise<void>;
  /** Publish a message to all instances subscribed to `room`. */
  publish(room: string, message: string): Promise<void>;
  /** Publish a direct user message (routed to whichever instance holds the connection). */
  publishToUser(userId: string, event: string, data: string): Promise<void>;
}

// ── History entry (event sourcing) ───────────────────────────────────────

/** A single broadcast-history record. */
export interface HistoryEntry {
  /** The room the message was broadcast in. */
  room: string;
  /** Serialised message payload. */
  message: string;
  /** Unix-ms timestamp of the broadcast. */
  timestamp: number;
  /** Unique message identifier. */
  messageId: string;
}

// ── Reconnect state ──────────────────────────────────────────────────────

/** Tracks reconnection attempts for a given connection. */
export interface ReconnectState {
  /** The connection/user ID. */
  id: string;
  /** Number of reconnect attempts so far. */
  attempts: number;
  /** Timestamp of the first attempt (ms). */
  firstAttemptAt: number;
  /** Timestamp of the last attempt (ms). */
  lastAttemptAt: number;
  /** Current backoff delay in ms. */
  currentBackoffMs: number;
  /** Whether the reconnection is considered permanently failed. */
  exhausted: boolean;
}

// ── Handler set ──────────────────────────────────────────────────────────

/** Callback invoked when a text/binary message arrives. */
export type WSMessageHandler<T = any> = (ctx: WSContext<T>, message: any) => void;

/** Callback invoked when a new connection opens. */
export type WSOpenHandler<T = any> = (ctx: WSContext<T>) => void;

/** Callback invoked when a connection closes. */
export type WSCloseHandler<T = any> = (ctx: WSContext<T>, code: number, reason: string) => void;

/** Callback invoked when the connection's backpressure buffer is drained. */
export type WSDrainHandler<T = any> = (ctx: WSContext<T>) => void;

/** All user-facing WebSocket handlers. */
export interface WSHandler<T extends Record<string, any> = {}> {
  open?: WSOpenHandler<T>;
  message?: WSMessageHandler<T>;
  close?: WSCloseHandler<T>;
  drain?: WSDrainHandler<T>;
}

// ── Main plugin options ──────────────────────────────────────────────────

/**
 * Configuration for the `ws()` Elysia plugin.
 *
 * Every field is optional with sensible defaults.
 */
export interface WSOptions {
  /** Enable room/pub-sub management. `true` uses all defaults. */
  rooms?: boolean | RoomConfig;
  /** Security configuration. */
  security?: SecurityConfig;
  /** Per-message compression settings. */
  compression?: CompressionConfig;
  /** Pub/Sub adapter for horizontal scaling. */
  pubSub?: PubSubAdapter;
  /** Idle timeout in seconds (default: 120). */
  idleTimeout?: number;
  /** Max payload size in bytes (default: 1 048 576 = 1 MB). */
  maxPayload?: number;
  /** Backpressure high-water mark in bytes (default: 1 048 576 = 1 MB). */
  highWaterMark?: number;
  /**
   * Enable broadcast history / event sourcing.
   * `true` uses default max of 100 entries per room.
   */
  history?: boolean | { maxEntriesPerRoom?: number };
  /** Enable Server-Sent Events fallback when WebSocket upgrade fails. */
  sseFallback?: boolean;
  /**
   * Enable message batching.
   * `true` uses default batch size of 16 and 10 ms flush interval.
   */
  batching?: boolean | { maxBatchSize?: number; flushInterval?: number };
  /**
   * Logger instance (defaults to `ernest-logger`).
   * Any object with `debug`, `info`, `warn`, `error` methods is accepted.
   */
  logger?: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  /**
   * Custom user-ID extractor.
   * Called after the connection is accepted; return a string to
   * associate the connection with a user.
   */
  extractUserId?: (ctx: any) => string | undefined;
}

import { TypedEmitter } from '../event-emitter.js';

// ── Internal Event Types ──────────────────────────────────────────

export interface InternalEvents {
    /** A new WebSocket connection was opened */
    connectionOpened: { connectionId: string; ip: string; userId?: string };
    /** A WebSocket connection was closed */
    connectionClosed: { connectionId: string; code: number; reason: string };
    /** A message was received from a connection */
    messageReceived: { connectionId: string; data: string; bytes: number };
    /** A message was sent to a connection */
    messageSent: { connectionId: string; data: string; bytes: number };
    /** A connection joined a room */
    roomJoined: { connectionId: string; room: string };
    /** A connection left a room */
    roomLeft: { connectionId: string; room: string };
    /** A broadcast was sent to a room */
    roomBroadcast: { room: string; message: string; recipientCount: number };
    /** Backpressure was detected on a connection */
    backpressureDetected: { connectionId: string; pendingBytes: number };
    /** Backpressure cleared on a connection */
    backpressureCleared: { connectionId: string };
    /** Rate limit was hit for a connection */
    rateLimitHit: { connectionId: string; droppedCount: number };
    /** A connection was rejected (throttle, auth, etc.) */
    connectionRejected: { ip: string; reason: string };
    /** Server started */
    serverStarted: { host: string; port: number };
    /** Server stopped */
    serverStopped: { reason: string };
    /** Error occurred in the native layer */
    nativeError: { error: Error; context?: string };
}

// ── Internal Event Bus ────────────────────────────────────────────

/**
 * Singleton-style event bus for internal plugin events.
 * Used by the plugin internals to coordinate between components
 * (e.g., metrics, logging, middleware) without tight coupling.
 */
export class InternalEventBus extends TypedEmitter<InternalEvents> {
    constructor() {
        super();
    }
}

// Global instance shared across the plugin
let globalBus: InternalEventBus | null = null;

/**
 * Get or create the global internal event bus instance.
 */
export function getEventBus(): InternalEventBus {
    if (!globalBus) {
        globalBus = new InternalEventBus();
    }
    return globalBus;
}

/**
 * Reset the global event bus. Useful for testing.
 */
export function resetEventBus(): void {
    globalBus = null;
}
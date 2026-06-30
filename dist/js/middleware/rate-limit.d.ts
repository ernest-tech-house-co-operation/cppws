import type { SecurityConfig } from '../../types/index.js';
/**
 * JavaScript-side rate limiter for per-connection message throttling.
 * Uses a sliding window algorithm matching the C++ implementation.
 *
 * This provides a defense-in-depth layer: the C++ core also enforces
 * rate limits, but the JS layer can reject messages before they reach
 * the native boundary.
 */
export declare class JSSideRateLimiter {
    private maxPerMinute;
    private maxPayloadBytes;
    private windows;
    private cleanupInterval;
    constructor(security: SecurityConfig);
    /**
     * Check if a message from a connection should be allowed.
     * Returns true if the message is within rate limits and payload size.
     * Returns false if it should be dropped.
     */
    check(connectionId: string, payloadSize: number): boolean;
    /**
     * Get the number of messages dropped for a connection due to rate limiting.
     */
    getDroppedCount(connectionId: string): number;
    /**
     * Remove all tracking for a connection (called on disconnect).
     */
    removeConnection(connectionId: string): void;
    /**
     * Get the number of tracked connections.
     */
    getTrackedCount(): number;
    /**
     * Destroy the rate limiter and stop the cleanup interval.
     */
    destroy(): void;
    private getDroppedWindow;
    private pruneStale;
}
/**
 * JavaScript-side connection throttler that limits the number of
 * concurrent WebSocket connections per IP address.
 */
export declare class JSSideConnectionThrottler {
    private maxPerIP;
    private ipCounts;
    constructor(security: SecurityConfig);
    /**
     * Check if a new connection from this IP should be allowed.
     */
    allow(ip: string): boolean;
    /**
     * Record that a connection from this IP was closed.
     */
    remove(ip: string): void;
    /**
     * Get the current connection count for an IP.
     */
    getCount(ip: string): number;
    /**
     * Destroy the throttler.
     */
    destroy(): void;
}
//# sourceMappingURL=rate-limit.d.ts.map
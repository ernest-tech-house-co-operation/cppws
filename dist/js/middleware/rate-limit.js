import logger from 'ernest-logger';
/**
 * JavaScript-side rate limiter for per-connection message throttling.
 * Uses a sliding window algorithm matching the C++ implementation.
 *
 * This provides a defense-in-depth layer: the C++ core also enforces
 * rate limits, but the JS layer can reject messages before they reach
 * the native boundary.
 */
export class JSSideRateLimiter {
    maxPerMinute;
    maxPayloadBytes;
    windows = new Map();
    cleanupInterval = null;
    constructor(security) {
        this.maxPerMinute = security.maxMessagesPerMinute ?? 60;
        this.maxPayloadBytes = security.maxPayloadBytes ?? 1048576;
        // Periodically prune stale entries
        this.cleanupInterval = setInterval(() => {
            this.pruneStale();
        }, 30000); // every 30 seconds
    }
    /**
     * Check if a message from a connection should be allowed.
     * Returns true if the message is within rate limits and payload size.
     * Returns false if it should be dropped.
     */
    check(connectionId, payloadSize) {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        // Check payload size first (cheaper)
        if (payloadSize > this.maxPayloadBytes) {
            this.getDroppedWindow(connectionId).droppedCount++;
            logger.warn(`[RateLimiter] Payload from ${connectionId} exceeds max size: ` +
                `${payloadSize} > ${this.maxPayloadBytes} bytes`);
            return false;
        }
        // Get or create window
        let window = this.windows.get(connectionId);
        if (!window) {
            window = { timestamps: [], droppedCount: 0 };
            this.windows.set(connectionId, window);
        }
        // Evict timestamps older than 1 minute
        while (window.timestamps.length > 0 && window.timestamps[0] < oneMinuteAgo) {
            window.timestamps.shift();
        }
        // Check rate
        if (window.timestamps.length >= this.maxPerMinute) {
            window.droppedCount++;
            logger.warn(`[RateLimiter] Connection ${connectionId} exceeded rate limit: ` +
                `${window.timestamps.length}/${this.maxPerMinute} messages in the last minute`);
            return false;
        }
        // Record this message
        window.timestamps.push(now);
        return true;
    }
    /**
     * Get the number of messages dropped for a connection due to rate limiting.
     */
    getDroppedCount(connectionId) {
        return this.windows.get(connectionId)?.droppedCount ?? 0;
    }
    /**
     * Remove all tracking for a connection (called on disconnect).
     */
    removeConnection(connectionId) {
        this.windows.delete(connectionId);
    }
    /**
     * Get the number of tracked connections.
     */
    getTrackedCount() {
        return this.windows.size;
    }
    /**
     * Destroy the rate limiter and stop the cleanup interval.
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.windows.clear();
    }
    getDroppedWindow(connectionId) {
        let window = this.windows.get(connectionId);
        if (!window) {
            window = { timestamps: [], droppedCount: 0 };
            this.windows.set(connectionId, window);
        }
        return window;
    }
    pruneStale() {
        const now = Date.now();
        const threshold = now - 120000; // 2 minutes (double the window)
        for (const [connId, window] of this.windows) {
            while (window.timestamps.length > 0 && window.timestamps[0] < threshold) {
                window.timestamps.shift();
            }
            // Remove if completely empty
            if (window.timestamps.length === 0 && window.droppedCount === 0) {
                this.windows.delete(connId);
            }
        }
    }
}
// ── Connection Throttler (JS Layer) ─────────────────────────────
/**
 * JavaScript-side connection throttler that limits the number of
 * concurrent WebSocket connections per IP address.
 */
export class JSSideConnectionThrottler {
    maxPerIP;
    ipCounts = new Map();
    constructor(security) {
        this.maxPerIP = security.maxConnectionsPerIP ?? 10;
    }
    /**
     * Check if a new connection from this IP should be allowed.
     */
    allow(ip) {
        const current = this.ipCounts.get(ip) ?? 0;
        if (current >= this.maxPerIP) {
            logger.warn(`[Throttler] Connection rejected from ${ip}: ` +
                `${current}/${this.maxPerIP} connections already open`);
            return false;
        }
        this.ipCounts.set(ip, current + 1);
        return true;
    }
    /**
     * Record that a connection from this IP was closed.
     */
    remove(ip) {
        const current = this.ipCounts.get(ip) ?? 0;
        if (current <= 1) {
            this.ipCounts.delete(ip);
        }
        else {
            this.ipCounts.set(ip, current - 1);
        }
    }
    /**
     * Get the current connection count for an IP.
     */
    getCount(ip) {
        return this.ipCounts.get(ip) ?? 0;
    }
    /**
     * Destroy the throttler.
     */
    destroy() {
        this.ipCounts.clear();
    }
}
//# sourceMappingURL=rate-limit.js.map
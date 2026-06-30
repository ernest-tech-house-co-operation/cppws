import logger from 'ernest-logger';
import { loadNative } from '../native-loader.js';
// ── Metrics Collector ──────────────────────────────────────────────
/**
 * Polls the native C++ metrics store every second and computes
 * derived values like `messagesPerSecond` and `slowClients`.
 */
export class MetricsCollector {
    native;
    intervalHandle = null;
    previousMessagesReceived = 0;
    previousMessagesSent = 0;
    currentMessagesPerSecond = 0;
    listeners = new Set();
    running = false;
    constructor() {
        this.native = loadNative();
    }
    /**
     * Start polling metrics every `intervalMs` milliseconds.
     * Defaults to 1000ms (1 second).
     */
    start(intervalMs = 1000) {
        if (this.running)
            return;
        this.running = true;
        logger.debug(`Metrics collector started (interval: ${intervalMs}ms)`);
        this.intervalHandle = setInterval(() => {
            try {
                const metrics = this.snapshot();
                this.notifyListeners(metrics);
            }
            catch (err) {
                logger.error(`Metrics poll error: ${err}`);
            }
        }, intervalMs);
    }
    /**
     * Stop polling metrics.
     */
    stop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        this.running = false;
        logger.debug('Metrics collector stopped');
    }
    /**
     * Take an immediate snapshot of all metrics (computed values included).
     */
    snapshot() {
        const raw = this.native.getMetrics();
        // Compute messages per second (received + sent)
        const totalNew = raw.totalMessagesReceived - this.previousMessagesReceived;
        const totalNewSent = raw.totalMessagesSent - this.previousMessagesSent;
        // Store the previous values for the next tick
        this.previousMessagesReceived = raw.totalMessagesReceived;
        this.previousMessagesSent = raw.totalMessagesSent;
        // Smoothed mps: simple average of in + out, assuming 1s interval
        this.currentMessagesPerSecond = totalNew + totalNewSent;
        // Slow clients = connections where backpressure is active.
        // The native layer tracks this; for now, estimate from activeConnections
        // In a real C++ integration, this comes from BackpressureManager::getPendingBytes
        const slowClients = 0; // Will be populated by native integration
        return {
            ...raw,
            messagesPerSecond: this.currentMessagesPerSecond,
            slowClients,
        };
    }
    /**
     * Register a callback to receive metrics snapshots on each poll tick.
     */
    onMetricsUpdate(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /**
     * Get the current messages-per-second value without taking a full snapshot.
     */
    getMessagesPerSecond() {
        return this.currentMessagesPerSecond;
    }
    /**
     * Check whether the collector is actively polling.
     */
    isActive() {
        return this.running;
    }
    notifyListeners(metrics) {
        for (const listener of this.listeners) {
            try {
                listener(metrics);
            }
            catch (err) {
                logger.error(`Metrics listener error: ${err}`);
            }
        }
    }
}
//# sourceMappingURL=metrics.js.map
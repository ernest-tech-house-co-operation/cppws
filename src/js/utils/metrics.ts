import logger from 'ernest-logger';
import { loadNative } from '../native-loader.js';

// ── Metrics Types ──────────────────────────────────────────────────

export interface WSMetrics {
    totalConnections: number;
    activeConnections: number;
    totalMessagesReceived: number;
    totalMessagesSent: number;
    totalBytesReceived: number;
    totalBytesSent: number;
    droppedMessages: number;
    rejectedConnections: number;
    uptime: number;
    messagesPerSecond: number;
    slowClients: number;
}

interface RawMetrics {
    totalConnections: number;
    activeConnections: number;
    totalMessagesReceived: number;
    totalMessagesSent: number;
    totalBytesReceived: number;
    totalBytesSent: number;
    droppedMessages: number;
    rejectedConnections: number;
    uptime: number;
}

// ── Metrics Collector ──────────────────────────────────────────────

/**
 * Polls the native C++ metrics store every second and computes
 * derived values like `messagesPerSecond` and `slowClients`.
 */
export class MetricsCollector {
    private native: ReturnType<typeof loadNative>;
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private previousMessagesReceived = 0;
    private previousMessagesSent = 0;
    private currentMessagesPerSecond = 0;
    private listeners = new Set<(metrics: WSMetrics) => void>();
    private running = false;

    constructor() {
        this.native = loadNative();
    }

    /**
     * Start polling metrics every `intervalMs` milliseconds.
     * Defaults to 1000ms (1 second).
     */
    start(intervalMs = 1000): void {
        if (this.running) return;
        this.running = true;
        logger.debug(`Metrics collector started (interval: ${intervalMs}ms)`);

        this.intervalHandle = setInterval(() => {
            try {
                const metrics = this.snapshot();
                this.notifyListeners(metrics);
            } catch (err) {
                logger.error(`Metrics poll error: ${err}`);
            }
        }, intervalMs);
    }

    /**
     * Stop polling metrics.
     */
    stop(): void {
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
    snapshot(): WSMetrics {
        const raw = this.native.getMetrics() as RawMetrics;

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
    onMetricsUpdate(listener: (metrics: WSMetrics) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Get the current messages-per-second value without taking a full snapshot.
     */
    getMessagesPerSecond(): number {
        return this.currentMessagesPerSecond;
    }

    /**
     * Check whether the collector is actively polling.
     */
    isActive(): boolean {
        return this.running;
    }

    private notifyListeners(metrics: WSMetrics): void {
        for (const listener of this.listeners) {
            try {
                listener(metrics);
            } catch (err) {
                logger.error(`Metrics listener error: ${err}`);
            }
        }
    }
}
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
/**
 * Polls the native C++ metrics store every second and computes
 * derived values like `messagesPerSecond` and `slowClients`.
 */
export declare class MetricsCollector {
    private native;
    private intervalHandle;
    private previousMessagesReceived;
    private previousMessagesSent;
    private currentMessagesPerSecond;
    private listeners;
    private running;
    constructor();
    /**
     * Start polling metrics every `intervalMs` milliseconds.
     * Defaults to 1000ms (1 second).
     */
    start(intervalMs?: number): void;
    /**
     * Stop polling metrics.
     */
    stop(): void;
    /**
     * Take an immediate snapshot of all metrics (computed values included).
     */
    snapshot(): WSMetrics;
    /**
     * Register a callback to receive metrics snapshots on each poll tick.
     */
    onMetricsUpdate(listener: (metrics: WSMetrics) => void): () => void;
    /**
     * Get the current messages-per-second value without taking a full snapshot.
     */
    getMessagesPerSecond(): number;
    /**
     * Check whether the collector is actively polling.
     */
    isActive(): boolean;
    private notifyListeners;
}
//# sourceMappingURL=metrics.d.ts.map
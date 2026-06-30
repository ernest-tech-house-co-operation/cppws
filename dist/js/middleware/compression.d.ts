import type { WSOptions, CompressionConfig } from '../../types/index.js';
/**
 * Message batcher that coalesces multiple send calls into fewer
 * TCP packets using a microtask/interval-based flush strategy.
 */
export declare class MessageBatcher {
    private buffer;
    private maxBatchSize;
    private flushInterval;
    private intervalHandle;
    private nativeServer;
    private isFlushing;
    constructor(nativeServer: any, options?: WSOptions['batching']);
    start(): void;
    broadcastToRoom(room: string, data: string): void;
    sendToConnection(connectionId: string, data: string): void;
    flush(): void;
    stop(): void;
    getBufferSize(): number;
}
export declare function shouldCompress(message: string, config?: CompressionConfig): boolean;
export declare function mergeCompressionConfig(config?: CompressionConfig): CompressionConfig;
//# sourceMappingURL=compression.d.ts.map
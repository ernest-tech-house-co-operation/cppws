import logger from 'ernest-logger';
/**
 * Message batcher that coalesces multiple send calls into fewer
 * TCP packets using a microtask/interval-based flush strategy.
 */
export class MessageBatcher {
    buffer = [];
    maxBatchSize;
    flushInterval;
    intervalHandle = null;
    nativeServer;
    isFlushing = false;
    constructor(nativeServer, options) {
        this.nativeServer = nativeServer;
        this.maxBatchSize = (typeof options === 'object' ? options?.maxBatchSize : undefined) ?? 50;
        this.flushInterval = (typeof options === 'object' ? options?.flushInterval : undefined) ?? 10;
    }
    start() {
        if (this.intervalHandle)
            return;
        this.intervalHandle = setInterval(() => this.flush(), this.flushInterval);
        logger.debug(`MessageBatcher started (maxBatch: ${this.maxBatchSize}, interval: ${this.flushInterval}ms)`);
    }
    broadcastToRoom(room, data) {
        this.buffer.push({ target: room, data });
        if (this.buffer.length >= this.maxBatchSize)
            setImmediate(() => this.flush());
    }
    sendToConnection(connectionId, data) {
        this.buffer.push({ target: `conn:${connectionId}`, data });
        if (this.buffer.length >= this.maxBatchSize)
            setImmediate(() => this.flush());
    }
    flush() {
        if (this.isFlushing || this.buffer.length === 0)
            return;
        this.isFlushing = true;
        const batch = this.buffer.splice(0);
        const roomGroups = new Map();
        const directSends = [];
        for (const entry of batch) {
            if (entry.target.startsWith('conn:')) {
                directSends.push({ connId: entry.target.slice(5), data: entry.data });
            }
            else {
                let group = roomGroups.get(entry.target);
                if (!group) {
                    group = [];
                    roomGroups.set(entry.target, group);
                }
                group.push(entry.data);
            }
        }
        for (const [room, messages] of roomGroups) {
            const coalesced = messages.length === 1 ? messages[0] : JSON.stringify(messages);
            this.nativeServer.broadcastToRoom(room, coalesced);
        }
        for (const { connId, data } of directSends) {
            this.nativeServer.sendToConnection(connId, data);
        }
        this.isFlushing = false;
    }
    stop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        this.flush();
        logger.debug('MessageBatcher stopped');
    }
    getBufferSize() { return this.buffer.length; }
}
// ── Compression helpers ───────────────────────────────────────
export function shouldCompress(message, config) {
    if (!config?.enabled)
        return false;
    return Buffer.byteLength(message) >= (config.threshold ?? 1024);
}
export function mergeCompressionConfig(config) {
    return {
        enabled: config?.enabled ?? false,
        level: config?.level ?? 3,
        threshold: config?.threshold ?? 1024,
    };
}
//# sourceMappingURL=compression.js.map
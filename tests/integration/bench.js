// benchmark.ts  — run with: bun benchmark.ts
import { ws } from './src/js/index.js';

const PORT = 9999;
const TOTAL_CONNECTIONS = 20000;
const MESSAGES_PER_CLIENT = 10;

// ── Start server ──────────────────────────────────────────────────
const server = ws({
    port: PORT,
    security: { maxConnectionsPerIP: 25000, maxMessagesPerMinute: 99999, maxPayloadBytes: 65536 },
})
    .onOpen(ctx => { ctx.send('hi'); })
    .onMessage((ctx, data) => { ctx.send('pong'); })
    .start();

await new Promise(r => setTimeout(r, 200));
console.log(`\n🚀 Server up on :${PORT}`);
console.log(`📡 Spawning ${TOTAL_CONNECTIONS} connections...\n`);

// ── Benchmark ─────────────────────────────────────────────────────
let connected     = 0;
let failed        = 0;
let totalMessages = 0;
const start       = performance.now();

async function runClient(): Promise<void> {
    return new Promise(resolve => {
        let received = 0;
        const socket = new WebSocket(`ws://localhost:${PORT}`);

        socket.onopen = () => {
            connected++;
            socket.send('ping');
        };

        socket.onmessage = () => {
            received++;
            totalMessages++;
            if (received < MESSAGES_PER_CLIENT) {
                socket.send('ping');
            } else {
                socket.close();
                resolve();
            }
        };

        socket.onerror = () => { failed++; resolve(); };
        socket.onclose = () => resolve();
    });
}

// Batch connections — don't slam all 20k at once or the OS will cry
const BATCH_SIZE = 500;
for (let i = 0; i < TOTAL_CONNECTIONS; i += BATCH_SIZE) {
    const batch = Array.from(
        { length: Math.min(BATCH_SIZE, TOTAL_CONNECTIONS - i) },
        () => runClient()
    );
    await Promise.all(batch);
    process.stdout.write(`\r  Connected: ${connected} | Failed: ${failed}`);
}

const elapsed    = (performance.now() - start) / 1000;
const msgPerSec  = Math.round(totalMessages / elapsed);

console.log(`\n\n📊 Results`);
console.log(`─────────────────────────────`);
console.log(`  Connections : ${connected} ok / ${failed} failed`);
console.log(`  Messages    : ${totalMessages}`);
console.log(`  Duration    : ${elapsed.toFixed(2)}s`);
console.log(`  Throughput  : ${msgPerSec.toLocaleString()} msg/sec`);
console.log(`─────────────────────────────\n`);

process.exit(0);
// Minimal isolated room test. Run with: bun room-test.js
// Bypasses your test framework entirely so we can see exactly where it hangs.

import { ws } from '../../src/js/index.js';
const PORT = 4455;
const server = ws({ port: PORT, rooms: true });

server.onOpen(ctx => {
    console.log('[server] open', ctx.id);
    ctx.join('test-room');
});

server.onMessage((ctx, data) => {
    console.log('[server] message', ctx.id, data);
});

server.start();

setTimeout(async () => {
    console.log('--- connecting client ---');
    const sock = new WebSocket(`ws://localhost:${PORT}`);

    sock.onopen = () => console.log('[client] open');

    sock.onmessage = (e) => {
    console.log('[client] received:', e.data);
    setImmediate(async () => {
        await server.shutdown();
        process.exit(0);
    });
};
    sock.onerror = (e) => console.log('[client] error', e);

    sock.onclose = () => console.log('[client] closed');

    // Give the connection time to register + join the room
    setTimeout(() => {
        console.log('--- broadcasting to room ---');
        console.log('roomManager state:', server.getRooms().getRoomInfo('test-room'));
        server.getRooms().broadcast('test-room', { hello: 'world' });
    }, 500);

    // Hard timeout so it never hangs silently
    setTimeout(() => {
        console.error('TIMEOUT: client never received the broadcast.');
        console.error('roomManager state at timeout:', server.getRooms().getRoomInfo('test-room'));
        process.exit(1);
    }, 3000);
}, 300);
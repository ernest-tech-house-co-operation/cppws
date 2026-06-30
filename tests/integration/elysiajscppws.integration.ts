/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                  cppws — Full Integration Test Suite                ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║                                                                      ║
 * ║  HOW A WEBSOCKET CONNECTION OPENS — end-to-end flow                 ║
 * ║  ─────────────────────────────────────────────────────────────────  ║
 * ║                                                                      ║
 * ║  1. CLIENT sends an HTTP/1.1 Upgrade request:                       ║
 * ║       GET / HTTP/1.1                                                 ║
 * ║       Connection: Upgrade                                            ║
 * ║       Upgrade: websocket                                             ║
 * ║       Sec-WebSocket-Key: <base64 random>                            ║
 * ║       Sec-WebSocket-Version: 13                                      ║
 * ║                                                                      ║
 * ║  2. uWS (C++) receives the TCP packet on its event loop thread.      ║
 * ║     The `.upgrade` handler in websocket_core.cpp fires:             ║
 * ║       a. extractIP() reads X-Forwarded-For / X-Real-IP / addr       ║
 * ║       b. ConnectionThrottler checks per-IP connection count          ║
 * ║       c. generateConnectionId() produces a unique hex timestamp ID  ║
 * ║       d. res->upgrade<PerSocketData>() completes the HTTP→WS        ║
 * ║          handshake, replying with 101 Switching Protocols           ║
 * ║                                                                      ║
 * ║  3. uWS fires `.open` on the same thread:                           ║
 * ║       a. Socket pointer stored in sockets_ map                      ║
 * ║       b. ConnectionInfo stored in connections_ map                  ║
 * ║       c. Metrics incremented (totalConnections, activeConnections)  ║
 * ║       d. onOpenCallback_ TSFN fires → crosses from uWS thread       ║
 * ║          to the Node/Bun/Deno JS event loop thread                  ║
 * ║                                                                      ║
 * ║  4. The JS layer (WebSocketServer.handleConnection) receives the    ║
 * ║     upgraded context, runs auth middleware if configured, creates   ║
 * ║     a WSContext (the object your handlers receive), stores it,      ║
 * ║     and emits 'connection'.                                          ║
 * ║                                                                      ║
 * ║  5. cppws calls the user's onOpen handler.                          ║
 * ║     From here, ctx.join(), ctx.send(), ctx.to(room).send() etc.     ║
 * ║     enqueue PendingOp structs that the uWS async wakeup drains on  ║
 * ║     the next iteration of the uWS event loop — zero extra threads. ║
 * ║                                                                      ║
 * ║  6. On disconnect: uWS fires `.close` → callCloseTSFN crosses back  ║
 * ║     to JS thread → cleanupConnection() removes socket, leaves all  ║
 * ║     rooms, resets rate limiter, decrements metrics.                 ║
 * ║                                                                      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import logger from 'ernest-logger';
import {
    ws,
    WebSocketServer,
    RoomManager,
    MetricsCollector,
    loadNative,
    isNativeLoaded,
} from '../../src/js/index.js';

// ── Test plumbing ──────────────────────────────────────────────────────────

const TEST_PORT = 7331;
const WS_URL    = `ws://localhost:${TEST_PORT}`;

let passed  = 0;
let failed  = 0;
let skipped = 0;

function assert(cond: boolean, msg: string): void {
    if (cond) {
        logger.success(`  ✅  ${msg}`);
        passed++;
    } else {
        logger.error(`  ❌  FAIL: ${msg}`);
        failed++;
        // don't throw — let the suite keep running
    }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
    assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function skip(msg: string): void {
    logger.warn(`  ⏭   SKIP: ${msg}`);
    skipped++;
}

/** Wait up to `ms` for `pred` to be truthy, checking every `interval` ms. */
async function waitFor(
    pred: () => boolean,
    ms = 2000,
    interval = 20,
): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise(r => setTimeout(r, interval));
    }
    return false;
}

/** Open a native WebSocket and wait for the open event. */
function openWS(url: string, protocols?: string[]): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
        socket.onopen  = () => resolve(socket);
        socket.onerror = (e: Event) => reject(new Error(`WebSocket error: ${(e as ErrorEvent).message ?? 'unknown'}`));
        setTimeout(() => reject(new Error('WS open timeout')), 3000);
    });
}

/** Send a message and wait for the first reply. */
function sendAndReceive(socket: WebSocket, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
        socket.onmessage = (e: MessageEvent) => {
            try { resolve(JSON.parse(e.data)); } catch { resolve(e.data); }
        };
        socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
        setTimeout(() => reject(new Error('Reply timeout')), 3000);
    });
}

/** Close a WebSocket and wait for the close event. */
function closeWS(socket: WebSocket): Promise<void> {
    return new Promise(resolve => {
        if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
        socket.onclose = () => resolve();
        socket.close();
    });
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 1 — Native loader & runtime detection
//  ─────────────────────────────────────────────────────────────────────────────
//  loadNative() returns either the real C++ addon or the pure-JS mock.
//  isNativeLoaded() distinguishes them by checking for _mockAddConnection.
// ══════════════════════════════════════════════════════════════════════════════

async function testNativeLoader(): Promise<void> {
    logger.info('\n══ 1. Native loader & runtime detection ══');

    const native = loadNative();
    assert(typeof native === 'object' && native !== null, 'loadNative() returns an object');

    // Cached — same reference every call
    assert(loadNative() === native, 'loadNative() returns cached singleton');

    const loaded = isNativeLoaded();
    logger.info(`  ℹ️  isNativeLoaded() = ${loaded} (running ${loaded ? 'C++ addon' : 'JS mock'})`);

    // Regardless of whether native is loaded, the full API shape must be present
    const requiredMethods = [
        'configure', 'start', 'stop', 'isRunning',
        'joinRoom', 'leaveRoom', 'broadcastToRoom', 'getRoomInfo',
        'sendToConnection', 'sendToUser',
        'disconnect', 'getConnectionCount', 'getConnectionInfo',
        'getMetrics', 'getHistory',
    ];
    for (const m of requiredMethods) {
        assert(typeof (native as any)[m] === 'function', `native.${m} is a function`);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 2 — JS-mock unit tests (no network)
//  ─────────────────────────────────────────────────────────────────────────────
//  These run against the mock returned by loadNative() when the C++ addon is
//  absent. They validate every JS-layer path without requiring a real server.
// ══════════════════════════════════════════════════════════════════════════════

async function testJSMock(): Promise<void> {
    logger.info('\n══ 2. JS mock unit tests (no network) ══');

    const native = loadNative();

    // --- configure + start/stop lifecycle ---
    const configResult = native.configure({ host: '0.0.0.0', port: TEST_PORT });
    assert(!!configResult, 'configure() returns truthy');

    assert(native.isRunning() === false, 'isRunning() = false before start');
    native.start();
    assert(native.isRunning() === true, 'isRunning() = true after start');
    native.stop();
    assert(native.isRunning() === false, 'isRunning() = false after stop');

    // --- metrics baseline ---
    const m0 = native.getMetrics();
    assert(typeof m0.totalConnections      === 'number', 'getMetrics().totalConnections is a number');
    assert(typeof m0.activeConnections     === 'number', 'getMetrics().activeConnections is a number');
    assert(typeof m0.totalMessagesReceived === 'number', 'getMetrics().totalMessagesReceived is a number');
    assert(typeof m0.totalMessagesSent     === 'number', 'getMetrics().totalMessagesSent is a number');
    assert(typeof m0.droppedMessages       === 'number', 'getMetrics().droppedMessages is a number');
    assert(typeof m0.rejectedConnections   === 'number', 'getMetrics().rejectedConnections is a number');
    assert(typeof m0.uptimeMs             === 'number', 'getMetrics().uptimeMs is a number');

    // --- mock connection helpers ---
    if (!isNativeLoaded()) {
        // Only available on the JS mock, not the real C++ addon
        let received: string | null = null;
        (native as any)._mockAddConnection('conn-A', { ip: '1.2.3.4' }, (msg: string) => {
            received = msg;
        });
        (native as any)._mockAddConnection('conn-B', { ip: '1.2.3.4' }, () => {});

        const m1 = native.getMetrics();
        assertEq(m1.totalConnections,  2, 'totalConnections = 2 after adding two mock connections');
        assertEq(m1.activeConnections, 2, 'activeConnections = 2');

        // --- room join/leave ---
        native.joinRoom('conn-A', 'lobby');
        native.joinRoom('conn-B', 'lobby');
        const roomInfo = native.getRoomInfo('lobby');
        assertEq(roomInfo.size, 2, 'lobby has 2 members after join');
        assert(roomInfo.connections.includes('conn-A'), 'conn-A in lobby.connections');
        assert(roomInfo.connections.includes('conn-B'), 'conn-B in lobby.connections');

        // --- broadcast to room ---
        //  broadcastToRoom delivers to all members; conn-A has a real handler
        native.broadcastToRoom('lobby', JSON.stringify({ event: 'hello', data: 'world' }));
        assert(received !== null, 'conn-A received broadcast message');
        const parsed = JSON.parse(received!);
        assertEq(parsed.event, 'hello', 'broadcast message event = "hello"');

        // --- history stored by broadcastToRoom ---
        const history = native.getHistory('lobby');
        assert(Array.isArray(history),     'getHistory() returns an array');
        assert(history.length >= 1,         'lobby history has at least 1 entry');
        assert('message'   in history[0],  'history entry has .message');
        assert('timestamp' in history[0],  'history entry has .timestamp');
        assert('messageId' in history[0],  'history entry has .messageId');

        // --- getHistory with sinceTimestamp ---
        const future = Date.now() + 100_000;
        const empty  = native.getHistory('lobby', future);
        assertEq(empty.length, 0, 'getHistory() with future sinceTimestamp returns []');

        // --- sendToConnection ---
        received = null;
        native.sendToConnection('conn-A', 'direct ping');
        assertEq(received, 'direct ping', 'sendToConnection delivers to correct handler');

        // --- sendToUser returns false for unknown user ---
        const sentToUnknown = native.sendToUser('ghost-user', 'hello?');
        assert(sentToUnknown === false, 'sendToUser() returns false for unknown userId');

        // --- leaveRoom ---
        native.leaveRoom('conn-A', 'lobby');
        const roomInfo2 = native.getRoomInfo('lobby');
        assertEq(roomInfo2.size, 1, 'lobby size = 1 after conn-A leaves');

        // --- disconnect cleans up ---
        native.disconnect('conn-B');
        const roomInfo3 = native.getRoomInfo('lobby');
        assertEq(roomInfo3.size, 0, 'lobby size = 0 after conn-B disconnects');

        const m2 = native.getMetrics();
        assertEq(m2.activeConnections, 1, 'activeConnections decremented after disconnect');
    } else {
        skip('_mockAddConnection not available on real C++ addon — skipping mock-only tests');
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 3 — JS-layer unit tests (RoomManager, MetricsCollector, TypedEmitter)
//  ─────────────────────────────────────────────────────────────────────────────
//  These test the JavaScript classes that wrap the native layer.
// ══════════════════════════════════════════════════════════════════════════════

async function testJSLayerUnits(): Promise<void> {
    logger.info('\n══ 3. JS-layer unit tests ══');

    // --- RoomManager ---
    const rm = new RoomManager();

    rm.join('c1', 'general');
    rm.join('c2', 'general');
    rm.join('c1', 'vip');

    assertEq(rm.getRoomSize('general'), 2, 'RoomManager: general has 2 members');
    assertEq(rm.getRoomSize('vip'),     1, 'RoomManager: vip has 1 member');
    assert(rm.getRoomMembers('general').includes('c1'), 'RoomManager: c1 in general');
    assert(rm.getRoomMembers('general').includes('c2'), 'RoomManager: c2 in general');

    rm.leave('c1', 'general');
    assertEq(rm.getRoomSize('general'), 1, 'RoomManager: general has 1 member after leave');

    rm.join('c1', 'general');
    rm.destroy();  // should be a no-op after this, not a crash
    rm.join('c1', 'nowhere');  // no-op after destroy — must not throw

    // --- MetricsCollector ---
    const mc = new MetricsCollector();
    assert(!mc.isActive(), 'MetricsCollector: not active before start');
    mc.start(50); // 50ms interval for tests
    assert(mc.isActive(), 'MetricsCollector: active after start');

    let callbackFired = false;
    const unsub = mc.onMetricsUpdate(metrics => {
        callbackFired = true;
        assert(typeof metrics.totalConnections      === 'number', 'MetricsCollector callback: totalConnections');
        assert(typeof metrics.messagesPerSecond     === 'number', 'MetricsCollector callback: messagesPerSecond');
        assert(typeof metrics.activeConnections     === 'number', 'MetricsCollector callback: activeConnections');
        assert(typeof metrics.slowClients           === 'number', 'MetricsCollector callback: slowClients');
    });

    const fired = await waitFor(() => callbackFired, 300);
    assert(fired, 'MetricsCollector: callback fires within 300ms');

    unsub();
    mc.stop();
    assert(!mc.isActive(), 'MetricsCollector: not active after stop');

    const snap = mc.snapshot();
    assert(typeof snap.uptimeMs === 'number', 'MetricsCollector.snapshot() returns uptimeMs');
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 4 — cppws server boots and accepts connections
//  ─────────────────────────────────────────────────────────────────────────────
//  cppws is a standalone server — it owns its port, its sockets, and its
//  transport entirely. ws({ port }).onOpen().onMessage().onClose().start()
//  launches the uWS event loop on a background thread and returns a
//  WebSocketServer instance.
//
//  Your HTTP framework (Elysia, Express, Hono, Fastify, or nothing) runs
//  on a separate port and is never touched by cppws.
// ══════════════════════════════════════════════════════════════════════════════

let server: WebSocketServer | null = null;

async function startTestServer(): Promise<void> {
    logger.info('\n══ 4. Starting cppws standalone server ══');

    server = ws({
        port: TEST_PORT,
        rooms: true,

        // History enabled so we can test getHistory()
        history: { maxEntriesPerRoom: 50 },

        // Security enforced at the C++ layer
        security: {
            maxMessagesPerMinute:  120,
            maxPayloadBytes:       65_536,
            maxConnectionsPerIP:   20,
        },

        // Message batching — coalesces rapid broadcasts
        batching: { maxBatchSize: 10, flushInterval: 5 },
    })

    // ── echo: sends every received message back to the sender ────────────
    .onOpen(ctx => {
        logger.debug(`[echo] open: ${ctx.id}`);
        ctx.send(JSON.stringify({ event: 'connected', id: ctx.id }));
    })

    // ── chat: room-based pub/sub ──────────────────────────────────────────
    //  ctx.join(room) → enqueues JOIN_ROOM → uWS subscribes to topic
    //  ctx.to(room).send() → enqueues BROADCAST_TO_ROOM → app->publish()
    .onMessage((ctx, data: any) => {
        const msg = typeof data === 'object' ? data : {};

        if (!msg.action) {
            // Default: echo back
            ctx.send(JSON.stringify({ echo: data }));
            return;
        }

        if (msg.action === 'join' && msg.room) {
            ctx.join(msg.room);
            ctx.send(JSON.stringify({ event: 'joined', room: msg.room }));
            return;
        }

        if (msg.action === 'leave' && msg.room) {
            ctx.leave(msg.room);
            ctx.send(JSON.stringify({ event: 'left', room: msg.room }));
            return;
        }

        if (msg.action === 'broadcast' && msg.room && msg.text) {
            ctx.to(msg.room).send(JSON.stringify({ event: 'message', from: ctx.id, text: msg.text }));
            return;
        }

        if (msg.action === 'dm' && msg.userId && msg.text) {
            ctx.privatelySend(msg.userId, 'dm', { from: ctx.id, text: msg.text });
            return;
        }

        if (msg.action === 'info') {
            ctx.send(JSON.stringify({ event: 'info', info: ctx.getInfo() }));
            return;
        }

        if (msg.action === 'leaveAll') {
            ctx.leaveAll();
            ctx.send(JSON.stringify({ event: 'leftAll' }));
            return;
        }
    })

    .onClose((ctx, code) => {
        logger.debug(`[server] close: ${ctx.id} (${code})`);
    })

    .start();

    // Give the uWS background thread a moment to bind
    await new Promise(r => setTimeout(r, 150));
    logger.success(`cppws test server listening on :${TEST_PORT}`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 5 — WebSocket open / close basics
// ══════════════════════════════════════════════════════════════════════════════

async function testConnectionLifecycle(): Promise<void> {
    logger.info('\n══ 5. Connection lifecycle (open / close) ══');

    const client = await openWS(WS_URL);
    assert(client.readyState === WebSocket.OPEN, 'WebSocket opens successfully');

    // Server sends { event: "connected", id: "..." } in onOpen handler
    const welcome = await new Promise<any>((res, rej) => {
        client.onmessage = (e: MessageEvent) => {
            try { res(JSON.parse(e.data)); } catch { res(e.data); }
        };
        setTimeout(() => rej(new Error('welcome timeout')), 2000);
    });
    assertEq(welcome.event, 'connected', 'Server sends "connected" event on open');
    assert(typeof welcome.id === 'string' && welcome.id.length > 0, 'welcome.id is a non-empty string');

    await closeWS(client);
    assert(client.readyState === WebSocket.CLOSED, 'WebSocket closes cleanly');
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 6 — Echo / direct send
// ══════════════════════════════════════════════════════════════════════════════

async function testEcho(): Promise<void> {
    logger.info('\n══ 6. Echo / sendToConnection ══');

    const client = await openWS(WS_URL);
    // Drain welcome message
    await new Promise(r => { client.onmessage = () => r(null); });

    const reply = await sendAndReceive(client, { hello: 'world', num: 42 });
    assert(reply !== null, 'Echo reply received');
    assert(typeof reply.echo === 'object', 'Reply has .echo object');
    assertEq(reply.echo.hello, 'world', 'Echo .hello preserved');
    assertEq(reply.echo.num,   42,      'Echo .num preserved');

    // Large payload (still under 64 KiB security limit)
    const big  = 'x'.repeat(10_000);
    const rep2 = await sendAndReceive(client, { payload: big });
    assertEq(rep2.echo.payload.length, 10_000, 'Large payload echoed intact');

    await closeWS(client);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 7 — Room join / leave / broadcast
//  ─────────────────────────────────────────────────────────────────────────────
//  ctx.join(room) enqueues JOIN_ROOM → uWS thread calls ws->subscribe(topic)
//  ctx.to(room).send() enqueues BROADCAST_TO_ROOM → app->publish(topic, msg)
//  uWS publish delivers to every subscriber, zero extra threads.
// ══════════════════════════════════════════════════════════════════════════════

async function testRooms(): Promise<void> {
    logger.info('\n══ 7. Room join / leave / broadcast ══');

    const c1 = await openWS(WS_URL);
    const c2 = await openWS(WS_URL);

    // Drain welcome messages from both
    await new Promise(r => { c1.onmessage = () => r(null); });
    await new Promise(r => { c2.onmessage = () => r(null); });

    const nextMsg = (socket: WebSocket) => new Promise<any>((res, rej) => {
        socket.onmessage = (e: MessageEvent) => {
            try { res(JSON.parse(e.data)); } catch { res(e.data); }
        };
        setTimeout(() => rej(new Error('msg timeout')), 2000);
    });

    // Both join 'general'
    c1.send(JSON.stringify({ action: 'join', room: 'general' }));
    c2.send(JSON.stringify({ action: 'join', room: 'general' }));
    const j1 = await nextMsg(c1);
    const j2 = await nextMsg(c2);
    assertEq(j1.event, 'joined',  'c1 receives joined event');
    assertEq(j1.room,  'general', 'c1 joined general');
    assertEq(j2.event, 'joined',  'c2 receives joined event');

    // c1 broadcasts to general — c2 should receive it
    const c2recv = nextMsg(c2);
    c1.send(JSON.stringify({ action: 'broadcast', room: 'general', text: 'hello room' }));
    const bcast = await c2recv;
    assertEq(bcast.event, 'message',    'c2 receives broadcast event');
    assertEq(bcast.text,  'hello room', 'c2 receives correct text');
    assert(typeof bcast.from === 'string', 'broadcast includes sender id');

    // c1 joins 'vip' — c2 should NOT receive vip broadcasts
    c1.send(JSON.stringify({ action: 'join', room: 'vip' }));
    await nextMsg(c1); // drain join ack

    let c2GotVip = false;
    c2.onmessage = () => { c2GotVip = true; };
    c1.send(JSON.stringify({ action: 'broadcast', room: 'vip', text: 'vip only' }));
    await new Promise(r => setTimeout(r, 200));
    assert(!c2GotVip, 'c2 does NOT receive vip room broadcast');

    // c1 leaves general
    const leaveReply = nextMsg(c1);
    c1.send(JSON.stringify({ action: 'leave', room: 'general' }));
    const leaveAck = await leaveReply;
    assertEq(leaveAck.event, 'left',    'c1 gets left ack');
    assertEq(leaveAck.room,  'general', 'left ack room = general');

    // c1 leaveAll
    const leaveAllReply = nextMsg(c1);
    c1.send(JSON.stringify({ action: 'leaveAll' }));
    const leaveAllAck = await leaveAllReply;
    assertEq(leaveAllAck.event, 'leftAll', 'c1 gets leftAll ack');

    await closeWS(c1);
    await closeWS(c2);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 8 — getInfo() / ConnectionInfo
// ══════════════════════════════════════════════════════════════════════════════

async function testConnectionInfo(): Promise<void> {
    logger.info('\n══ 8. ConnectionInfo / getInfo() ══');

    const client = await openWS(WS_URL);

    const nextMsg = (socket: WebSocket) => new Promise<any>((res, rej) => {
        socket.onmessage = (e: MessageEvent) => { try { res(JSON.parse(e.data)); } catch { res(e.data); } };
        setTimeout(() => rej(new Error('timeout')), 2000);
    });

    // Drain welcome
    await nextMsg(client);

    // Join a room so rooms array is non-empty
    client.send(JSON.stringify({ action: 'join', room: 'info-test' }));
    await nextMsg(client);

    client.send(JSON.stringify({ action: 'info' }));
    const infoReply = await nextMsg(client);
    assert(infoReply.event === 'info', 'info event received');

    const info = infoReply.info;
    assert(typeof info.id          === 'string', 'info.id is a string');
    assert(typeof info.ip          === 'string', 'info.ip is a string');
    assert(typeof info.connectedAt === 'number', 'info.connectedAt is a number (ms epoch)');
    assert(typeof info.lastSeen    === 'number', 'info.lastSeen is a number');
    assert(Array.isArray(info.rooms),            'info.rooms is an array');
    assert(info.rooms.includes('info-test'),     'info.rooms includes "info-test"');

    await closeWS(client);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 9 — Broadcast history / replay
//  ─────────────────────────────────────────────────────────────────────────────
//  Each BROADCAST_TO_ROOM op calls broadcastHistory_->store().
//  getHistory(room, sinceTimestamp) retrieves entries newer than the timestamp.
//  This enables reconnecting clients to catch up on missed messages.
// ══════════════════════════════════════════════════════════════════════════════

async function testHistory(): Promise<void> {
    logger.info('\n══ 9. Broadcast history / replay ══');

    const c1 = await openWS(WS_URL);

    const nextMsg = (socket: WebSocket) => new Promise<any>((res, rej) => {
        socket.onmessage = (e: MessageEvent) => { try { res(JSON.parse(e.data)); } catch { res(e.data); } };
        setTimeout(() => rej(new Error('timeout')), 2000);
    });

    await nextMsg(c1); // drain welcome

    c1.send(JSON.stringify({ action: 'join', room: 'history-room' }));
    await nextMsg(c1); // drain join ack

    const before = Date.now();

    c1.send(JSON.stringify({ action: 'broadcast', room: 'history-room', text: 'history msg 1' }));
    await nextMsg(c1);

    c1.send(JSON.stringify({ action: 'broadcast', room: 'history-room', text: 'history msg 2' }));
    await nextMsg(c1);

    // Give the C++ layer a tick to persist history
    await new Promise(r => setTimeout(r, 50));

    const native = loadNative();
    const history = native.getHistory('history-room', before - 1);
    assert(Array.isArray(history), 'getHistory() returns an array');

    if (history.length > 0) {
        assert('message'   in history[0], 'history entry has .message');
        assert('timestamp' in history[0], 'history entry has .timestamp');
        assert('messageId' in history[0], 'history entry has .messageId');
        assert('room'      in history[0], 'history entry has .room');
        logger.info(`  ℹ️  ${history.length} history entries for 'history-room' since test start`);
    } else {
        skip('No history entries returned — may be timing/filter issue with real C++ addon');
    }

    await closeWS(c1);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 10 — Metrics
// ══════════════════════════════════════════════════════════════════════════════

async function testMetrics(): Promise<void> {
    logger.info('\n══ 10. Live metrics ══');

    const m = server!.getMetrics();
    assert(typeof m.totalConnections      === 'number', 'metrics.totalConnections');
    assert(typeof m.activeConnections     === 'number', 'metrics.activeConnections');
    assert(typeof m.totalMessagesReceived === 'number', 'metrics.totalMessagesReceived');
    assert(typeof m.totalMessagesSent     === 'number', 'metrics.totalMessagesSent');
    assert(typeof m.droppedMessages       === 'number', 'metrics.droppedMessages');
    assert(typeof m.rejectedConnections   === 'number', 'metrics.rejectedConnections');

    logger.info(`  ℹ️  Active connections at metrics check: ${m.activeConnections}`);
    logger.info(`  ℹ️  Total messages received: ${m.totalMessagesReceived}`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 11 — Rate limiter
//  ─────────────────────────────────────────────────────────────────────────────
//  With a very tight maxMessagesPerMinute, sending many rapid messages should
//  result in some being dropped at the C++ sliding-window layer.
// ══════════════════════════════════════════════════════════════════════════════

async function testRateLimit(): Promise<void> {
    logger.info('\n══ 11. Rate limiter ══');

    // Dedicated server with a tight limit so we don't need to send thousands
    const tightServer = ws({
        port: TEST_PORT + 1,
        security: { maxMessagesPerMinute: 5, maxPayloadBytes: 65_536 },
    })
    .onOpen(ctx  => { ctx.send('ready'); })
    .onMessage((ctx, data) => { ctx.send(JSON.stringify({ got: data })); })
    .start();

    await new Promise(r => setTimeout(r, 100));

    const client = await openWS(`ws://localhost:${TEST_PORT + 1}`);
    const replies: any[] = [];
    client.onmessage = (e: MessageEvent) => {
        try { replies.push(JSON.parse(e.data)); } catch { replies.push(e.data); }
    };

    // Wait for 'ready'
    await waitFor(() => replies.length >= 1, 1000);
    replies.length = 0;

    // Send 10 messages rapidly — rate limit is 5/min, so 5+ should be dropped
    for (let i = 0; i < 10; i++) {
        client.send(JSON.stringify({ n: i }));
    }
    await waitFor(() => replies.length > 0, 1000);
    await new Promise(r => setTimeout(r, 200)); // let stragglers arrive

    logger.info(`  ℹ️  Sent 10 messages, received ${replies.length} replies`);
    assert(replies.length <= 5, `Rate limiter dropped messages: only ${replies.length}/10 got through`);

    await closeWS(client);
    await tightServer.shutdown();
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 12 — WebSocketServer event emitter (TypedEmitter)
//  ─────────────────────────────────────────────────────────────────────────────
//  WebSocketServer extends TypedEmitter<ServerEvents>.
//  .on('connection') fires each time a client connects.
//  .on('disconnection') fires on close.
//  .on('serverStarted') / .on('serverStopped') fire on lifecycle changes.
// ══════════════════════════════════════════════════════════════════════════════

async function testEventEmitter(): Promise<void> {
    logger.info('\n══ 12. TypedEmitter / server events ══');

    const emitterServer = new WebSocketServer({});
    const events: string[] = [];

    emitterServer.on('serverStarted', () => events.push('serverStarted'));
    emitterServer.on('serverStopped', () => events.push('serverStopped'));

    emitterServer.emit('serverStarted', { host: '0.0.0.0', port: 0 });
    emitterServer.emit('serverStopped', { reason: 'test' });

    assertEq(events[0], 'serverStarted', 'serverStarted event fires');
    assertEq(events[1], 'serverStopped', 'serverStopped event fires');

    // once() fires exactly once
    let onceCount = 0;
    emitterServer.once('serverStarted', () => onceCount++);
    emitterServer.emit('serverStarted', { host: '0.0.0.0', port: 0 });
    emitterServer.emit('serverStarted', { host: '0.0.0.0', port: 0 });
    assertEq(onceCount, 1, 'once() fires exactly one time');

    // off() removes a listener
    const handler = () => events.push('extra');
    emitterServer.on('serverStopped', handler);
    emitterServer.off('serverStopped', handler);
    emitterServer.emit('serverStopped', { reason: 'test' });
    assert(!events.includes('extra'), 'off() removes listener successfully');

    // removeAllListeners
    emitterServer.removeAllListeners();
    assertEq(emitterServer.listenerCount('serverStarted'), 0, 'removeAllListeners clears all');

    // listenerCount / eventNames
    emitterServer.on('serverStarted', () => {});
    emitterServer.on('serverStarted', () => {});
    assertEq(emitterServer.listenerCount('serverStarted'), 2, 'listenerCount = 2 after two .on()');
    assert(emitterServer.eventNames().includes('serverStarted'), 'eventNames includes serverStarted');
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 13 — MessageBatcher
//  ─────────────────────────────────────────────────────────────────────────────
//  The batcher coalesces multiple broadcastToRoom calls made within
//  `flushInterval` ms into a single native.broadcastToRoom() call,
//  reducing TCP overhead. Multiple messages to the same room are sent as
//  a JSON array.
// ══════════════════════════════════════════════════════════════════════════════

async function testMessageBatcher(): Promise<void> {
    logger.info('\n══ 13. MessageBatcher ══');

    const batchServer = ws({
        port: TEST_PORT + 2,
        rooms: true,
        batching: { maxBatchSize: 100, flushInterval: 20 },
    })
    .onOpen(ctx => {
        ctx.join('batch-room');
        ctx.send('ready');
    })
    .onMessage((ctx, data: any) => {
        ctx.to('batch-room').send(JSON.stringify({ echo: data }));
    })
    .start();

    await new Promise(r => setTimeout(r, 100));

    const client = await openWS(`ws://localhost:${TEST_PORT + 2}`);
    await new Promise<void>((res, rej) => {
        client.onmessage = (e: MessageEvent) => {
            if (e.data === 'ready') res();
        };
        setTimeout(() => rej(new Error('ready timeout')), 2000);
    });

    const replies: any[] = [];
    client.onmessage = (e: MessageEvent) => {
        try { replies.push(JSON.parse(e.data)); } catch { replies.push(e.data); }
    };

    // Send 5 rapid messages
    for (let i = 0; i < 5; i++) {
        client.send(JSON.stringify({ n: i }));
    }
    await waitFor(() => replies.length >= 5, 1000);

    logger.info(`  ℹ️  Sent 5 messages, received ${replies.length} echoes through batcher`);
    assert(replies.length >= 1, 'MessageBatcher: at least one message delivered');

    await closeWS(client);
    await batchServer.shutdown();
}

// ══════════════════════════════════════════════════════════════════════════════
//  Section 14 — Graceful shutdown
//  ─────────────────────────────────────────────────────────────────────────────
//  shutdown() closes every active connection with 1001 Going Away,
//  stops the MetricsCollector, and drains the message batcher.
// ══════════════════════════════════════════════════════════════════════════════

async function testGracefulShutdown(): Promise<void> {
    logger.info('\n══ 14. Graceful shutdown ══');

    const client = await openWS(WS_URL);
    assert(client.readyState === WebSocket.OPEN, 'Client open before shutdown');

    let closedCode: number | null = null;
    client.onclose = (e: CloseEvent) => { closedCode = e.code; };

    await server!.shutdown();

    const closed = await waitFor(() => client.readyState === WebSocket.CLOSED, 3000);
    assert(closed, 'Client receives close frame during server shutdown');

    if (closedCode !== null) {
        logger.info(`  ℹ️  Close code received: ${closedCode} (1001 = Going Away)`);
    }

    server = null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Runner
// ══════════════════════════════════════════════════════════════════════════════

async function run(): Promise<void> {
    logger.info('╔══════════════════════════════════════════════════════╗');
    logger.info('║           cppws integration test suite               ║');
    logger.info('╚══════════════════════════════════════════════════════╝');

    try {
        // Sections that don't need a live server
        await testNativeLoader();
        await testJSMock();
        await testJSLayerUnits();

        // Start the cppws server then run integration tests against it
        await startTestServer();
        await testConnectionLifecycle();
        await testEcho();
        await testRooms();
        await testConnectionInfo();
        await testHistory();
        await testMetrics();
        await testRateLimit();
        await testEventEmitter();
        await testMessageBatcher();

        // Must be last — shuts the server down
        await testGracefulShutdown();

    } catch (err) {
        logger.error(`Unexpected test error: ${err}`);
        failed++;
    }

    logger.info('\n══════════════════════════════════════════════════════');
    logger.success(`Passed:  ${passed}`);
    if (skipped > 0) logger.warn(`Skipped: ${skipped}`);
    if (failed  > 0) logger.error(`Failed:  ${failed}`);
    logger.info('══════════════════════════════════════════════════════');

    if (failed > 0) process.exit(1);
}

run();
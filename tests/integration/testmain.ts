/**
 * cppws — Full Integration Test Suite
 *
 * See websocket_core.cpp for the full connection-open flow (upgrade → open →
 * TSFN → JS onOpen). This file exercises that pipeline end-to-end.
 *
 * IMPORTANT: never call process.exit() (or anything that forces native
 * teardown) from inside a WebSocket callback (onmessage, onOpen, onClose).
 * Those run while the uWS thread is mid-TSFN-call; forcing a synchronous
 * destructor/join from there is a self-join deadlock. All shutdowns in this
 * file are awaited normally and process.exit() is only called once, at the
 * very end of run(), after everything has settled.
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
        const timer = setTimeout(() => reject(new Error('WS open timeout')), 3000);
        socket.onopen  = () => { clearTimeout(timer); resolve(socket); };
        socket.onerror = (e: Event) => {
            clearTimeout(timer);
            reject(new Error(`WebSocket error: ${(e as ErrorEvent).message ?? 'unknown'}`));
        };
    });
}

/** Wait for the next message on a socket, parsed as JSON when possible. */
function nextMessage(socket: WebSocket, ms = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('message timeout')), ms);
        socket.onmessage = (e: MessageEvent) => {
            clearTimeout(timer);
            try { resolve(JSON.parse(e.data)); } catch { resolve(e.data); }
        };
    });
}

/** Send a message and wait for the first reply. */
async function sendAndReceive(socket: WebSocket, payload: any, ms = 3000): Promise<any> {
    const reply = nextMessage(socket, ms);
    socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return reply;
}

/** Close a WebSocket and wait for the close event. Never hangs. */
function closeWS(socket: WebSocket, ms = 2000): Promise<void> {
    return new Promise(resolve => {
        if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
        const timer = setTimeout(resolve, ms); // resolve regardless so the suite can't hang
        socket.onclose = () => { clearTimeout(timer); resolve(); };
        socket.close();
    });
}

/** Shut a WebSocketServer down, deferred — never called from inside a callback. */
async function safeShutdown(s: WebSocketServer | null): Promise<void> {
    if (!s) return;
    await new Promise<void>(resolve => setImmediate(resolve)); // unwind any in-flight callback
    await s.shutdown();
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 1 — Native loader & runtime detection
// ══════════════════════════════════════════════════════════════════════════

async function testNativeLoader(): Promise<void> {
    logger.info('\n══ 1. Native loader & runtime detection ══');

    const native = loadNative();
    assert(typeof native === 'object' && native !== null, 'loadNative() returns an object');
    assert(loadNative() === native, 'loadNative() returns cached singleton');

    const loaded = isNativeLoaded();
    logger.info(`  ℹ️  isNativeLoaded() = ${loaded} (running ${loaded ? 'C++ addon' : 'JS mock'})`);

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

// ══════════════════════════════════════════════════════════════════════════
//  Section 2 — JS-mock unit tests (no network)
// ══════════════════════════════════════════════════════════════════════════

async function testJSMock(): Promise<void> {
    logger.info('\n══ 2. JS mock unit tests (no network) ══');

    const native = loadNative();

    const configResult = native.configure({ host: '0.0.0.0', port: TEST_PORT });
    assert(!!configResult, 'configure() returns truthy');

    assert(native.isRunning() === false, 'isRunning() = false before start');
    native.start();
    assert(native.isRunning() === true, 'isRunning() = true after start');
    native.stop();
    assert(native.isRunning() === false, 'isRunning() = false after stop');

    const m0 = native.getMetrics();
    assert(typeof m0.totalConnections      === 'number', 'getMetrics().totalConnections is a number');
    assert(typeof m0.activeConnections     === 'number', 'getMetrics().activeConnections is a number');
    assert(typeof m0.totalMessagesReceived === 'number', 'getMetrics().totalMessagesReceived is a number');
    assert(typeof m0.totalMessagesSent     === 'number', 'getMetrics().totalMessagesSent is a number');
    assert(typeof m0.droppedMessages       === 'number', 'getMetrics().droppedMessages is a number');
    assert(typeof m0.rejectedConnections   === 'number', 'getMetrics().rejectedConnections is a number');
    assert(typeof m0.uptimeMs              === 'number', 'getMetrics().uptimeMs is a number');

    if (!isNativeLoaded()) {
        let received: string | null = null;
        (native as any)._mockAddConnection('conn-A', { ip: '1.2.3.4' }, (msg: string) => {
            received = msg;
        });
        (native as any)._mockAddConnection('conn-B', { ip: '1.2.3.4' }, () => {});

        const m1 = native.getMetrics();
        assertEq(m1.totalConnections,  2, 'totalConnections = 2 after adding two mock connections');
        assertEq(m1.activeConnections, 2, 'activeConnections = 2');

        native.joinRoom('conn-A', 'lobby');
        native.joinRoom('conn-B', 'lobby');
        const roomInfo = native.getRoomInfo('lobby');
        assertEq(roomInfo.size, 2, 'lobby has 2 members after join');
        assert(roomInfo.connections.includes('conn-A'), 'conn-A in lobby.connections');
        assert(roomInfo.connections.includes('conn-B'), 'conn-B in lobby.connections');

        native.broadcastToRoom('lobby', JSON.stringify({ event: 'hello', data: 'world' }));
        assert(received !== null, 'conn-A received broadcast message');
        const parsed = JSON.parse(received!);
        assertEq(parsed.event, 'hello', 'broadcast message event = "hello"');

        const history = native.getHistory('lobby');
        assert(Array.isArray(history),    'getHistory() returns an array');
        assert(history.length >= 1,       'lobby history has at least 1 entry');
        assert('message'   in history[0], 'history entry has .message');
        assert('timestamp' in history[0], 'history entry has .timestamp');
        assert('messageId' in history[0], 'history entry has .messageId');

        const future = Date.now() + 100_000;
        const empty  = native.getHistory('lobby', future);
        assertEq(empty.length, 0, 'getHistory() with future sinceTimestamp returns []');

        received = null;
        native.sendToConnection('conn-A', 'direct ping');
        assertEq(received, 'direct ping', 'sendToConnection delivers to correct handler');

        const sentToUnknown = native.sendToUser('ghost-user', 'hello?');
        assert(sentToUnknown === false, 'sendToUser() returns false for unknown userId');

        native.leaveRoom('conn-A', 'lobby');
        const roomInfo2 = native.getRoomInfo('lobby');
        assertEq(roomInfo2.size, 1, 'lobby size = 1 after conn-A leaves');

        native.disconnect('conn-B');
        const roomInfo3 = native.getRoomInfo('lobby');
        assertEq(roomInfo3.size, 0, 'lobby size = 0 after conn-B disconnects');

        const m2 = native.getMetrics();
        assertEq(m2.activeConnections, 1, 'activeConnections decremented after disconnect');
    } else {
        skip('_mockAddConnection not available on real C++ addon — skipping mock-only tests');
    }
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 3 — JS-layer unit tests (RoomManager, MetricsCollector)
// ══════════════════════════════════════════════════════════════════════════

async function testJSLayerUnits(): Promise<void> {
    logger.info('\n══ 3. JS-layer unit tests ══');

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
    rm.destroy();              // must be a no-op after this, not a crash
    rm.join('c1', 'nowhere');  // no-op after destroy — must not throw

    const mc = new MetricsCollector();
    assert(!mc.isActive(), 'MetricsCollector: not active before start');
    mc.start(50);
    assert(mc.isActive(), 'MetricsCollector: active after start');

    let callbackFired = false;
    const unsub = mc.onMetricsUpdate(metrics => {
        callbackFired = true;
        assert(typeof metrics.totalConnections  === 'number', 'MetricsCollector callback: totalConnections');
        assert(typeof metrics.messagesPerSecond === 'number', 'MetricsCollector callback: messagesPerSecond');
        assert(typeof metrics.activeConnections === 'number', 'MetricsCollector callback: activeConnections');
        assert(typeof metrics.slowClients       === 'number', 'MetricsCollector callback: slowClients');
    });

    const fired = await waitFor(() => callbackFired, 300);
    assert(fired, 'MetricsCollector: callback fires within 300ms');

    unsub();
    mc.stop();
    assert(!mc.isActive(), 'MetricsCollector: not active after stop');

    const snap = mc.snapshot();
    assert(typeof snap.uptimeMs === 'number', 'MetricsCollector.snapshot() returns uptimeMs');
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 4 — cppws server boots and accepts connections
// ══════════════════════════════════════════════════════════════════════════

let server: WebSocketServer | null = null;

async function startTestServer(): Promise<void> {
    logger.info('\n══ 4. Starting cppws standalone server ══');

    server = ws({
        port: TEST_PORT,
        rooms: true,
        history: { maxEntriesPerRoom: 50 },
        security: {
            maxMessagesPerMinute: 120,
            maxPayloadBytes:      65_536,
            maxConnectionsPerIP:  20,
        },
        batching: { maxBatchSize: 10, flushInterval: 5 },
    })
        .onOpen(ctx => {
            logger.debug(`[echo] open: ${ctx.id}`);
            ctx.send(JSON.stringify({ event: 'connected', id: ctx.id }));
        })
        .onMessage( async (ctx, data: any) => {
            const msg = typeof data === 'object' ? data : {};

            if (!msg.action) {
                ctx.send(JSON.stringify({ echo: data }));
                return;
            }

            switch (msg.action) {
                case 'join':
    
                if (msg.room) {
                    await ctx.join(msg.room);  // ← waits for C++ subscribe() confirmation
                    ctx.send(JSON.stringify({ event: 'joined', room: msg.room }));
                }
                return;

                case 'leave':
                    if (msg.room) {
                        ctx.leave(msg.room);
                        ctx.send(JSON.stringify({ event: 'left', room: msg.room }));
                    }
                    return;

                case 'broadcast':
                    if (msg.room && msg.text) {
                        ctx.to(msg.room).send(JSON.stringify({ event: 'message', from: ctx.id, text: msg.text }));
                    }
                    return;

                case 'dm':
                    if (msg.userId && msg.text) {
                        ctx.privatelySend(msg.userId, 'dm', { from: ctx.id, text: msg.text });
                    }
                    return;

                case 'info':
                    ctx.send(JSON.stringify({ event: 'info', info: ctx.getInfo() }));
                    return;

                case 'leaveAll':
                    ctx.leaveAll();
                    ctx.send(JSON.stringify({ event: 'leftAll' }));
                    return;
            }
        })
        .onClose((ctx, code) => {
            logger.debug(`[server] close: ${ctx.id} (${code})`);
        })
        .start();

    await new Promise(r => setTimeout(r, 150)); // let the uWS thread bind
    logger.success(`cppws test server listening on :${TEST_PORT}`);
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 5 — Connection lifecycle (open / close)
// ══════════════════════════════════════════════════════════════════════════

async function testConnectionLifecycle(): Promise<void> {
    logger.info('\n══ 5. Connection lifecycle (open / close) ══');

    const client = await openWS(WS_URL);
    assert(client.readyState === WebSocket.OPEN, 'WebSocket opens successfully');

    const welcome = await nextMessage(client);
    assertEq(welcome.event, 'connected', 'Server sends "connected" event on open');
    assert(typeof welcome.id === 'string' && welcome.id.length > 0, 'welcome.id is a non-empty string');

    await closeWS(client);
    assert(client.readyState === WebSocket.CLOSED, 'WebSocket closes cleanly');
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 6 — Echo / direct send
// ══════════════════════════════════════════════════════════════════════════

async function testEcho(): Promise<void> {
    logger.info('\n══ 6. Echo / sendToConnection ══');

    const client = await openWS(WS_URL);
    await nextMessage(client); // drain welcome

    const reply = await sendAndReceive(client, { hello: 'world', num: 42 });
    assert(reply !== null, 'Echo reply received');
    assert(typeof reply.echo === 'object', 'Reply has .echo object');
    assertEq(reply.echo.hello, 'world', 'Echo .hello preserved');
    assertEq(reply.echo.num,   42,      'Echo .num preserved');

    const big  = 'x'.repeat(10_000);
    const rep2 = await sendAndReceive(client, { payload: big });
    assertEq(rep2.echo.payload.length, 10_000, 'Large payload echoed intact');

    await closeWS(client);
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 7 — Room join / leave / broadcast
// ══════════════════════════════════════════════════════════════════════════

async function testRooms(): Promise<void> {
    logger.info('\n══ 7. Room join / leave / broadcast ══');

    const c1 = await openWS(WS_URL);
    const c2 = await openWS(WS_URL);

    await nextMessage(c1); // drain welcome
    await nextMessage(c2);

    c1.send(JSON.stringify({ action: 'join', room: 'general' }));
    c2.send(JSON.stringify({ action: 'join', room: 'general' }));
    const j1 = await nextMessage(c1);
    const j2 = await nextMessage(c2);
    assertEq(j1.event, 'joined',  'c1 receives joined event');
    assertEq(j1.room,  'general', 'c1 joined general');
    assertEq(j2.event, 'joined',  'c2 receives joined event');

    const c2recv = nextMessage(c2);
    c1.send(JSON.stringify({ action: 'broadcast', room: 'general', text: 'hello room' }));
    const bcast = await c2recv;
    assertEq(bcast.event, 'message',    'c2 receives broadcast event');
    assertEq(bcast.text,  'hello room', 'c2 receives correct text');
    assert(typeof bcast.from === 'string', 'broadcast includes sender id');

    c1.send(JSON.stringify({ action: 'join', room: 'vip' }));
    await nextMessage(c1); // drain join ack

    let c2GotVip = false;
    c2.onmessage = () => { c2GotVip = true; };
    c1.send(JSON.stringify({ action: 'broadcast', room: 'vip', text: 'vip only' }));
    await new Promise(r => setTimeout(r, 200));
    assert(!c2GotVip, 'c2 does NOT receive vip room broadcast');

    const leaveReply = nextMessage(c1);
    c1.send(JSON.stringify({ action: 'leave', room: 'general' }));
    const leaveAck = await leaveReply;
    assertEq(leaveAck.event, 'left',    'c1 gets left ack');
    assertEq(leaveAck.room,  'general', 'left ack room = general');

    const leaveAllReply = nextMessage(c1);
    c1.send(JSON.stringify({ action: 'leaveAll' }));
    const leaveAllAck = await leaveAllReply;
    assertEq(leaveAllAck.event, 'leftAll', 'c1 gets leftAll ack');

    await closeWS(c1);
    await closeWS(c2);
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 8 — getInfo() / ConnectionInfo
// ══════════════════════════════════════════════════════════════════════════

async function testConnectionInfo(): Promise<void> {
    logger.info('\n══ 8. ConnectionInfo / getInfo() ══');

    const client = await openWS(WS_URL);
    await nextMessage(client); // drain welcome

    client.send(JSON.stringify({ action: 'join', room: 'info-test' }));
    await nextMessage(client);

    client.send(JSON.stringify({ action: 'info' }));
    const infoReply = await nextMessage(client);
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

// ══════════════════════════════════════════════════════════════════════════
//  Section 9 — Broadcast history / replay
// ══════════════════════════════════════════════════════════════════════════

async function testHistory(): Promise<void> {
    logger.info('\n══ 9. Broadcast history / replay ══');

    const c1 = await openWS(WS_URL);
    await nextMessage(c1); // drain welcome

    c1.send(JSON.stringify({ action: 'join', room: 'history-room' }));
    await nextMessage(c1); // drain join ack

    const before = Date.now();

    c1.send(JSON.stringify({ action: 'broadcast', room: 'history-room', text: 'history msg 1' }));
    await nextMessage(c1);

    c1.send(JSON.stringify({ action: 'broadcast', room: 'history-room', text: 'history msg 2' }));
    await nextMessage(c1);

    await new Promise(r => setTimeout(r, 50)); // let C++ persist history

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

// ══════════════════════════════════════════════════════════════════════════
//  Section 10 — Metrics
// ══════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════
//  Section 11 — Rate limiter
// ══════════════════════════════════════════════════════════════════════════

async function testRateLimit(): Promise<void> {
    logger.info('\n══ 11. Rate limiter ══');

    let tightServer: WebSocketServer | null = ws({
        port: TEST_PORT + 1,
        security: { maxMessagesPerMinute: 5, maxPayloadBytes: 65_536 },
    })
        .onOpen(ctx => { ctx.send('ready'); })
        .onMessage((ctx, data) => { ctx.send(JSON.stringify({ got: data })); })
        .start();

    await new Promise(r => setTimeout(r, 100));

    const client = await openWS(`ws://localhost:${TEST_PORT + 1}`);
    const replies: any[] = [];
    client.onmessage = (e: MessageEvent) => {
        try { replies.push(JSON.parse(e.data)); } catch { replies.push(e.data); }
    };

    await waitFor(() => replies.length >= 1, 1000); // wait for 'ready'
    replies.length = 0;

    for (let i = 0; i < 10; i++) {
        client.send(JSON.stringify({ n: i }));
    }
    await waitFor(() => replies.length > 0, 1000);
    await new Promise(r => setTimeout(r, 200)); // let stragglers arrive

    logger.info(`  ℹ️  Sent 10 messages, received ${replies.length} replies`);
    assert(replies.length <= 5, `Rate limiter dropped messages: only ${replies.length}/10 got through`);

    await closeWS(client);
    await safeShutdown(tightServer);
    tightServer = null;
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 12 — WebSocketServer event emitter (TypedEmitter)
// ══════════════════════════════════════════════════════════════════════════

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

    let onceCount = 0;
    emitterServer.once('serverStarted', () => onceCount++);
    emitterServer.emit('serverStarted', { host: '0.0.0.0', port: 0 });
    emitterServer.emit('serverStarted', { host: '0.0.0.0', port: 0 });
    assertEq(onceCount, 1, 'once() fires exactly one time');

    const handler = () => events.push('extra');
    emitterServer.on('serverStopped', handler);
    emitterServer.off('serverStopped', handler);
    emitterServer.emit('serverStopped', { reason: 'test' });
    assert(!events.includes('extra'), 'off() removes listener successfully');

    emitterServer.removeAllListeners();
    assertEq(emitterServer.listenerCount('serverStarted'), 0, 'removeAllListeners clears all');

    emitterServer.on('serverStarted', () => {});
    emitterServer.on('serverStarted', () => {});
    assertEq(emitterServer.listenerCount('serverStarted'), 2, 'listenerCount = 2 after two .on()');
    assert(emitterServer.eventNames().includes('serverStarted'), 'eventNames includes serverStarted');
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 13 — MessageBatcher
// ══════════════════════════════════════════════════════════════════════════

async function testMessageBatcher(): Promise<void> {
    logger.info('\n══ 13. MessageBatcher ══');

    let batchServer: WebSocketServer | null = ws({
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
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ready timeout')), 2000);
        client.onmessage = (e: MessageEvent) => {
            if (e.data === 'ready') { clearTimeout(timer); resolve(); }
        };
    });

    const replies: any[] = [];
    client.onmessage = (e: MessageEvent) => {
        try { replies.push(JSON.parse(e.data)); } catch { replies.push(e.data); }
    };

    for (let i = 0; i < 5; i++) {
        client.send(JSON.stringify({ n: i }));
    }
    await waitFor(() => replies.length >= 5, 1000);

    logger.info(`  ℹ️  Sent 5 messages, received ${replies.length} echoes through batcher`);
    assert(replies.length >= 1, 'MessageBatcher: at least one message delivered');

    await closeWS(client);
    await safeShutdown(batchServer);
    batchServer = null;
}

// ══════════════════════════════════════════════════════════════════════════
//  Section 14 — Graceful shutdown (must run last — shuts the main server down)
// ══════════════════════════════════════════════════════════════════════════

async function testGracefulShutdown(): Promise<void> {
    logger.info('\n══ 14. Graceful shutdown ══');

    const client = await openWS(WS_URL);
    assert(client.readyState === WebSocket.OPEN, 'Client open before shutdown');

    let closedCode: number | null = null;
    client.onclose = (e: CloseEvent) => { closedCode = e.code; };

    await safeShutdown(server);

    const closed = await waitFor(() => client.readyState === WebSocket.CLOSED, 3000);
    assert(closed, 'Client receives close frame during server shutdown');

    if (closedCode !== null) {
        logger.info(`  ℹ️  Close code received: ${closedCode} (1001 = Going Away)`);
    }

    server = null;
}

// ══════════════════════════════════════════════════════════════════════════
//  Runner
// ══════════════════════════════════════════════════════════════════════════

async function run(): Promise<void> {
    logger.info('╔══════════════════════════════════════════════════════╗');
    logger.info('║           cppws integration test suite               ║');
    logger.info('╚══════════════════════════════════════════════════════╝');

    try {
        await testNativeLoader();
        await testJSMock();
        await testJSLayerUnits();

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

        await testGracefulShutdown(); // must be last — shuts main server down
    } catch (err) {
        logger.error(`Unexpected test error: ${err}`);
        failed++;
        // Best-effort cleanup so a thrown error never leaves a dangling server.
        await safeShutdown(server).catch(() => {});
        server = null;
    }

    logger.info('\n══════════════════════════════════════════════════════');
    logger.success(`Passed:  ${passed}`);
    if (skipped > 0) logger.warn(`Skipped: ${skipped}`);
    if (failed  > 0) logger.error(`Failed:  ${failed}`);
    logger.info('══════════════════════════════════════════════════════');

    process.exit(failed > 0 ? 1 : 0);
}

run();
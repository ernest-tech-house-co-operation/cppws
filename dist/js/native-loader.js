import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from 'ernest-logger';
const nativeRequire = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function detectRuntime() {
    if (typeof globalThis.Bun !== 'undefined')
        return 'bun';
    if (typeof globalThis.Deno !== 'undefined')
        return 'deno';
    return 'node';
}
function getPlatformTag(runtime) {
    const platform = process.platform;
    const arch = process.arch;
    let libc = '';
    if (platform === 'linux' && runtime !== 'deno') {
        libc = detectLibc();
    }
    const libcSuffix = libc ? `-${libc}` : '';
    switch (runtime) {
        case 'bun': {
            const bunMajor = parseInt((globalThis.Bun?.version ?? '1').split('.')[0], 10);
            return `bun-${bunMajor}-${platform}-${arch}${libcSuffix}`;
        }
        case 'deno': {
            const denoMajor = parseInt((globalThis.Deno?.version?.deno ?? '1').split('.')[0], 10);
            return `deno-${denoMajor}-${platform}-${arch}`;
        }
        default: {
            const napiVer = process.versions.napi ?? '8';
            return `node-${napiVer}-${platform}-${arch}${libcSuffix}`;
        }
    }
}
function detectLibc() {
    if (process.platform !== 'linux')
        return '';
    try {
        const fs = nativeRequire('fs');
        const ldd = fs.readFileSync('/usr/bin/ldd', 'utf8');
        return ldd.includes('musl') ? 'musl' : 'gnu';
    }
    catch {
        return '';
    }
}
function findProjectRoot(startDir) {
    const fs = nativeRequire('fs');
    let dir = startDir;
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(join(dir, 'package.json')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return join(startDir, '..', '..');
}
const PROJECT_ROOT = findProjectRoot(__dirname);
// ── Addon loading ─────────────────────────────────────────────
function tryLoadModule(candidatePath) {
    try {
        return nativeRequire(candidatePath);
    }
    catch {
        return null;
    }
}
function unwrapAddon(raw, tag) {
    if (!raw || typeof raw !== 'object')
        return null;
    const mod = raw;
    if (typeof mod.configure === 'function')
        return mod;
    if (typeof mod.WebSocketServer === 'function') {
        try {
            const instance = new mod.WebSocketServer();
            logger.success(`[native-loader] Instantiated WebSocketServer from ${tag}`);
            return instance;
        }
        catch (e) {
            logger.error(`[native-loader] Failed to instantiate WebSocketServer from ${tag}: ${e}`);
            return null;
        }
    }
    logger.warn(`[native-loader] Addon at ${tag} has unrecognised shape — skipping`);
    return null;
}
function loadNativeAddon(runtime) {
    // Updated addon name: cppws_native.node
    const addonName = 'cppws_native.node';
    // Strategy 1: runtime-aware prebuild (e.g. bun-1-linux-x64-gnu)
    const runtimeTag = getPlatformTag(runtime);
    const s1 = unwrapAddon(tryLoadModule(join(PROJECT_ROOT, 'prebuilds', runtimeTag, addonName)), runtimeTag);
    if (s1)
        return s1;
    // Strategy 2: plain platform tag (e.g. linux-x64-gnu)
    const libc = process.platform === 'linux' ? detectLibc() : '';
    const plainTag = `${process.platform}-${process.arch}${libc ? `-${libc}` : ''}`;
    const s2 = unwrapAddon(tryLoadModule(join(PROJECT_ROOT, 'prebuilds', plainTag, addonName)), plainTag);
    if (s2)
        return s2;
    // Strategy 3 & 4: cmake-js local build
    if (runtime !== 'deno') {
        const s3 = unwrapAddon(tryLoadModule(join(PROJECT_ROOT, 'build', 'Release', addonName)), 'build/Release');
        if (s3)
            return s3;
        const s4 = unwrapAddon(tryLoadModule(join(PROJECT_ROOT, 'build', 'Debug', addonName)), 'build/Debug');
        if (s4)
            return s4;
    }
    return null;
}
// ── Pure-JS mock fallback ─────────────────────────────────────
function createJSMock() {
    const runtime = detectRuntime();
    logger.warn(`[native-loader] No native addon found (runtime: ${runtime}). Running in pure-JS mock mode.`);
    logger.warn('[native-loader] Performance will be degraded. Run "npm run build:cpp" for full speed.');
    const connections = new Map();
    const userMap = new Map();
    const rooms = new Map();
    const connRooms = new Map();
    const history = new Map();
    const metrics = {
        totalConnections: 0,
        activeConnections: 0,
        totalMessagesReceived: 0,
        totalMessagesSent: 0,
        totalBytesReceived: 0,
        totalBytesSent: 0,
        droppedMessages: 0,
        rejectedConnections: 0,
    };
    let startedAt = 0;
    let running = false;
    // Stored callbacks set via configure()
    let _onOpen;
    let _onMessage;
    let _onClose;
    let _onDrain;
    return {
        configure(opts) {
            if (typeof opts.onOpen === 'function')
                _onOpen = opts.onOpen;
            if (typeof opts.onMessage === 'function')
                _onMessage = opts.onMessage;
            if (typeof opts.onClose === 'function')
                _onClose = opts.onClose;
            if (typeof opts.onDrain === 'function')
                _onDrain = opts.onDrain;
            logger.info('[JS mock] configured');
            return true;
        },
        start() {
            running = true;
            startedAt = Date.now();
            logger.info('[JS mock] server started');
            return true;
        },
        stop() {
            running = false;
            logger.info('[JS mock] server stopped');
            return true;
        },
        isRunning() { return running; },
        // ── Room ops ─────────────────────────────────────────────
        joinRoom(connId, room) {
            if (!rooms.has(room))
                rooms.set(room, new Set());
            if (!connRooms.has(connId))
                connRooms.set(connId, new Set());
            rooms.get(room).add(connId);
            connRooms.get(connId).add(room);
        },
        leaveRoom(connId, room) {
            rooms.get(room)?.delete(connId);
            connRooms.get(connId)?.delete(room);
        },
        broadcastToRoom(room, message) {
            const members = rooms.get(room);
            if (members) {
                metrics.totalMessagesSent += members.size;
                for (const cid of members) {
                    const conn = connections.get(cid);
                    if (conn?.sendFn)
                        conn.sendFn(message);
                    // Also fire onMessage callback so the JS layer sees it
                    if (_onMessage)
                        _onMessage({ connectionId: cid, data: message });
                }
            }
            if (!history.has(room))
                history.set(room, []);
            const entries = history.get(room);
            entries.push({ room, message, timestamp: Date.now(), messageId: `mock-${Date.now()}` });
            if (entries.length > 100)
                entries.shift();
        },
        getRoomInfo(room) {
            const members = rooms.get(room);
            return {
                name: room,
                size: members?.size ?? 0,
                connections: members ? [...members] : [],
            };
        },
        // ── Direct send ──────────────────────────────────────────
        sendToConnection(connId, message) {
            const conn = connections.get(connId);
            if (conn?.sendFn) {
                conn.sendFn(message);
                metrics.totalMessagesSent++;
                return true;
            }
            return false;
        },
        sendToUser(userId, message) {
            const connId = userMap.get(userId);
            if (connId) {
                const conn = connections.get(connId);
                if (conn?.sendFn) {
                    conn.sendFn(message);
                    metrics.totalMessagesSent++;
                    return true;
                }
            }
            return false;
        },
        // ── Connection management ────────────────────────────────
        disconnect(connId) {
            const conn = connections.get(connId);
            if (conn) {
                connections.delete(connId);
                const cr = connRooms.get(connId);
                if (cr) {
                    for (const room of cr)
                        rooms.get(room)?.delete(connId);
                    connRooms.delete(connId);
                }
                metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
                if (_onClose)
                    _onClose({ connectionId: connId, code: 1000, reason: 'disconnected' });
            }
        },
        getConnectionCount() { return connections.size; },
        getConnectionInfo(connId) {
            const conn = connections.get(connId);
            if (!conn)
                return null;
            return { ...conn.info, rooms: [...(connRooms.get(connId) ?? [])] };
        },
        // ── Metrics ──────────────────────────────────────────────
        getMetrics() {
            return { ...metrics, uptimeMs: running ? Date.now() - startedAt : 0 };
        },
        // ── History ──────────────────────────────────────────────
        getHistory(room, sinceTimestamp) {
            const entries = history.get(room) ?? [];
            return sinceTimestamp !== undefined
                ? entries.filter(e => e.timestamp >= sinceTimestamp)
                : entries;
        },
        // ── Test helpers ─────────────────────────────────────────
        _mockAddConnection(connId, info, sendFn) {
            connections.set(connId, { info, sendFn });
            metrics.totalConnections++;
            metrics.activeConnections++;
            // Fire onOpen so WebSocketServer builds a WSContext for this mock conn
            if (_onOpen)
                _onOpen({ connectionId: connId, ip: info.ip ?? 'mock', path: '/' });
        },
    };
}
// ── Public API ────────────────────────────────────────────────
let cachedNative = null;
/**
 * Load and cache the native C++ addon (or JS mock fallback).
 * Runtime agnostic: Node.js, Bun, Deno.
 */
export function loadNative() {
    if (cachedNative)
        return cachedNative;
    const runtime = detectRuntime();
    logger.info(`[native-loader] Detected runtime: ${runtime}`);
    const addon = loadNativeAddon(runtime);
    cachedNative = addon ?? createJSMock();
    return cachedNative;
}
/**
 * Returns true if the real C++ addon is loaded (vs the JS mock).
 */
export function isNativeLoaded() {
    return !('_mockAddConnection' in loadNative());
}
/**
 * Returns the detected runtime: 'node' | 'bun' | 'deno'.
 */
export function getRuntime() {
    return detectRuntime();
}
//# sourceMappingURL=native-loader.js.map
import logger from 'ernest-logger';
// ── Context Factory ───────────────────────────────────────────────
/**
 * Create a WSContext object for a given WebSocket connection.
 *
 * All sends go through the C++ native layer — no runtime API (Bun/Node/Deno)
 * is touched here. cppws owns the sockets via uWebSockets so broadcastToRoom,
 * sendToConnection, etc. all work identically on every runtime.
 */
export function createWSContext(connectionId, ip, nativeServer, options, roomManager) {
    const rooms = new Set();
    let _userId;
    let _store = {};
    let _headers = {};
    let _query = {};
    let _cookie;
    let _jwt;
    let _request;
    const connectedAt = Date.now();
    // ── Helper: serialize data for wire ─────────────────────────
    function serialize(data) {
        if (data === undefined || data === null)
            return '';
        if (typeof data === 'string')
            return data;
        return JSON.stringify(data);
    }
    // ── Helper: room sender ──────────────────────────────────────
    function createRoomSender(room) {
        return {
            send(data) {
                nativeServer.broadcastToRoom(room, serialize(data));
            },
            emit(event, data) {
                nativeServer.broadcastToRoom(room, serialize({ event, data }));
            },
        };
    }
    // ── Context object ───────────────────────────────────────────
    const context = {
        id: connectionId,
        get userId() { return _userId; },
        set userId(value) { _userId = value; },
        ip,
        rooms,
        // ── Room Operations ──────────────────────────────────────
        join(room) {
            rooms.add(room);
            if (roomManager) {
                roomManager.join(connectionId, room);
            }
            else {
                nativeServer.joinRoom(connectionId, room);
            }
            logger.debug(`[WS] ${connectionId} joined room: ${room}`);
            return context;
        },
        leave(room) {
            rooms.delete(room);
            if (roomManager) {
                roomManager.leave(connectionId, room);
            }
            else {
                nativeServer.leaveRoom(connectionId, room);
            }
            logger.debug(`[WS] ${connectionId} left room: ${room}`);
            return context;
        },
        leaveAll() {
            const roomList = Array.from(rooms);
            if (roomManager) {
                roomManager.leaveAll(connectionId);
            }
            else {
                for (const room of roomList) {
                    nativeServer.leaveRoom(connectionId, room);
                }
            }
            logger.debug(`[WS] ${connectionId} left all rooms: [${roomList.join(', ')}]`);
            rooms.clear();
            return context;
        },
        // ── Messaging ────────────────────────────────────────────
        send(data) {
            nativeServer.sendToConnection(connectionId, serialize(data));
            return context;
        },
        emit(event, data) {
            nativeServer.sendToConnection(connectionId, serialize({ event: String(event), data }));
            return context;
        },
        to(room) {
            return createRoomSender(room);
        },
        privatelySend(userId, event, data) {
            const sent = nativeServer.sendToUser(userId, serialize({ event, data }));
            if (!sent) {
                logger.warn(`[WS] Failed to privately send to user ${userId} — not connected to this instance`);
            }
        },
        // ── Connection Control ───────────────────────────────────
        close(code, reason) {
            nativeServer.disconnect(connectionId);
            logger.info(`[WS] ${connectionId} closed (code: ${code ?? 1000}, reason: ${reason ?? ''})`);
        },
        getInfo() {
            const nativeInfo = nativeServer.getConnectionInfo(connectionId);
            if (nativeInfo) {
                return {
                    ...nativeInfo,
                    id: connectionId,
                    ip,
                    userId: _userId,
                    rooms: Array.from(rooms),
                    connectedAt,
                };
            }
            return {
                id: connectionId,
                ip,
                userId: _userId,
                rooms: Array.from(rooms),
                connectedAt,
                lastSeen: Date.now(),
                messagesReceived: 0,
                messagesSent: 0,
                bytesReceived: 0,
                bytesSent: 0,
            };
        },
        // ── Elysia/Framework Context Passthrough ─────────────────
        get store() { return _store; },
        set store(v) { _store = v; },
        get headers() { return _headers; },
        set headers(v) { _headers = v; },
        get query() { return _query; },
        set query(v) { _query = v; },
        get cookie() { return _cookie; },
        set cookie(v) { _cookie = v; },
        get jwt() { return _jwt; },
        set jwt(v) { _jwt = v; },
        get request() { return _request; },
        set request(v) { _request = v; },
        // ── Internal References ──────────────────────────────────
        _nativeRef: nativeServer,
        _server: nativeServer,
    };
    return context;
}
//# sourceMappingURL=ws-context.js.map
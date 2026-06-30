import type { WSContext, WSOptions, ConnectionInfo, RoomSender } from '../types/index.js';
import logger from 'ernest-logger';
import type { RoomManager } from './room-manager.js';

// ── Context Factory ───────────────────────────────────────────────

/**
 * Create a WSContext object for a given WebSocket connection.
 *
 * All sends go through the C++ native layer — no runtime API (Bun/Node/Deno)
 * is touched here. cppws owns the sockets via uWebSockets so broadcastToRoom,
 * sendToConnection, etc. all work identically on every runtime.
 */
export function createWSContext<T extends Record<string, any>>(
    connectionId: string,
    ip: string,
    nativeServer: any,
    options: WSOptions<T>,
    roomManager?: RoomManager,
): WSContext<T> {
    const rooms = new Set<string>();
    let _userId: string | undefined;
    let _store: any = {};
    let _headers: Record<string, string> = {};
    let _query: Record<string, string> = {};
    let _cookie: any;
    let _jwt: any;
    let _request: any;
    const connectedAt = Date.now();

    // ── Helper: serialize data for wire ─────────────────────────
    function serialize(data: any): string {
        if (data === undefined || data === null) return '';
        if (typeof data === 'string') return data;
        return JSON.stringify(data);
    }

    // ── Helper: room sender ──────────────────────────────────────
    function createRoomSender(room: string): RoomSender<T> {
        return {
            send(data: any): void {
                nativeServer.broadcastToRoom(room, serialize(data));
            },
            emit<K extends keyof T & string>(event: K, data: T[K]): void {
                nativeServer.broadcastToRoom(room, serialize({ event, data }));
            },
        };
    }

    // ── Context object ───────────────────────────────────────────
    const context: WSContext<T> = {
        id: connectionId,

        get userId(): string | undefined { return _userId; },
        set userId(value: string | undefined) { _userId = value; },

        ip,
        rooms,

        // ── Room Operations ──────────────────────────────────────
        join(room: string): WSContext<T> {
            rooms.add(room);
            if (roomManager) {
                roomManager.join(connectionId, room);
            } else {
                nativeServer.joinRoom(connectionId, room);
            }
            logger.debug(`[WS] ${connectionId} joined room: ${room}`);
            return context;
        },

        leave(room: string): WSContext<T> {
            rooms.delete(room);
            if (roomManager) {
                roomManager.leave(connectionId, room);
            } else {
                nativeServer.leaveRoom(connectionId, room);
            }
            logger.debug(`[WS] ${connectionId} left room: ${room}`);
            return context;
        },

        leaveAll(): WSContext<T> {
            const roomList = Array.from(rooms);
            if (roomManager) {
                roomManager.leaveAll(connectionId);
            } else {
                for (const room of roomList) {
                    nativeServer.leaveRoom(connectionId, room);
                }
            }
            logger.debug(`[WS] ${connectionId} left all rooms: [${roomList.join(', ')}]`);
            rooms.clear();
            return context;
        },

        // ── Messaging ────────────────────────────────────────────
        send(data: any): WSContext<T> {
            nativeServer.sendToConnection(connectionId, serialize(data));
            return context;
        },

        emit<K extends keyof T & string>(event: K, data: T[K]): WSContext<T> {
            nativeServer.sendToConnection(connectionId, serialize({ event: String(event), data }));
            return context;
        },

        to(room: string): RoomSender<T> {
            return createRoomSender(room);
        },

        privatelySend(userId: string, event: string, data: any): void {
            const sent = nativeServer.sendToUser(userId, serialize({ event, data }));
            if (!sent) {
                logger.warn(`[WS] Failed to privately send to user ${userId} — not connected to this instance`);
            }
        },

        // ── Connection Control ───────────────────────────────────
        close(code?: number, reason?: string): void {
            nativeServer.disconnect(connectionId);
            logger.info(`[WS] ${connectionId} closed (code: ${code ?? 1000}, reason: ${reason ?? ''})`);
        },

        getInfo(): ConnectionInfo {
            const nativeInfo = nativeServer.getConnectionInfo(connectionId);
            if (nativeInfo) {
                return {
                    ...nativeInfo,
                    id: connectionId,
                    ip,
                    userId: _userId,
                    rooms: Array.from(rooms),
                    connectedAt,
                } as ConnectionInfo;
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
        get store(): any { return _store; },
        set store(v: any) { _store = v; },

        get headers(): Record<string, string> { return _headers; },
        set headers(v: Record<string, string>) { _headers = v; },

        get query(): Record<string, string> { return _query; },
        set query(v: Record<string, string>) { _query = v; },

        get cookie(): any { return _cookie; },
        set cookie(v: any) { _cookie = v; },

        get jwt(): any { return _jwt; },
        set jwt(v: any) { _jwt = v; },

        get request(): any { return _request; },
        set request(v: any) { _request = v; },

        // ── Internal References ──────────────────────────────────
        _nativeRef: nativeServer,
        _server: nativeServer,
    };

    return context;
}
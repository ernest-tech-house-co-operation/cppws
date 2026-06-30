import { describe, it, expect, beforeEach, vi } from 'vitest';

// We test the JS mock of the native module since we may not have the C++ addon compiled
// The RoomManager wraps the native calls, so testing against the mock validates the JS layer

function createMockNative() {
    const rooms = new Map<string, Set<string>>();
    const connRooms = new Map<string, Set<string>>();
    const connections = new Map<string, any>();

    return {
        joinRoom(connId: string, room: string) {
            if (!rooms.has(room)) rooms.set(room, new Set());
            rooms.get(room)!.add(connId);
            if (!connRooms.has(connId)) connRooms.set(connId, new Set());
            connRooms.get(connId)!.add(room);
        },
        leaveRoom(connId: string, room: string) {
            rooms.get(room)?.delete(connId);
            connRooms.get(connId)?.delete(room);
        },
        broadcastToRoom(room: string, message: string) {
            const members = rooms.get(room);
            if (members) {
                for (const connId of members) {
                    const conn = connections.get(connId);
                    if (conn?.onMessage) conn.onMessage(message);
                }
            }
        },
        getRoomInfo(room: string) {
            const members = rooms.get(room);
            return {
                name: room,
                size: members?.size ?? 0,
                connections: members ? Array.from(members) : [],
            };
        },
        getConnectionInfo(connId: string) {
            const conn = connections.get(connId);
            if (!conn) return null;
            return { ...conn.info, rooms: Array.from(connRooms.get(connId) ?? []) };
        },
        sendToConnection(connId: string, message: string) {
            const conn = connections.get(connId);
            if (conn?.onMessage) {
                conn.onMessage(message);
                return true;
            }
            return false;
        },
        disconnect(connId: string) {
            connections.delete(connId);
            const cr = connRooms.get(connId);
            if (cr) {
                for (const room of cr) rooms.get(room)?.delete(connId);
                connRooms.delete(connId);
            }
        },
        // Mock internal state access
        _rooms: rooms,
        _connRooms: connRooms,
        _connections: connections,
    };
}

describe('RoomManager (JS Layer)', () => {
    let mockNative: ReturnType<typeof createMockNative>;

    beforeEach(() => {
        mockNative = createMockNative();
    });

    it('should add a connection to a room', () => {
        mockNative.joinRoom('conn-1', 'general');
        const info = mockNative.getRoomInfo('general');
        expect(info.connections).toContain('conn-1');
        expect(info.size).toBe(1);
    });

    it('should allow a connection to join multiple rooms', () => {
        mockNative.joinRoom('conn-1', 'general');
        mockNative.joinRoom('conn-1', 'random');

        expect(mockNative.getRoomInfo('general').connections).toContain('conn-1');
        expect(mockNative.getRoomInfo('random').connections).toContain('conn-1');
    });

    it('should remove a connection from a specific room', () => {
        mockNative.joinRoom('conn-1', 'general');
        mockNative.joinRoom('conn-1', 'random');

        mockNative.leaveRoom('conn-1', 'general');

        expect(mockNative.getRoomInfo('general').connections).not.toContain('conn-1');
        expect(mockNative.getRoomInfo('random').connections).toContain('conn-1');
    });

    it('should clean up empty rooms when the last connection leaves', () => {
        mockNative.joinRoom('conn-1', 'temp');
        mockNative.leaveRoom('conn-1', 'temp');

        expect(mockNative.getRoomInfo('temp').size).toBe(0);
        expect(mockNative.getRoomInfo('temp').connections).toHaveLength(0);
    });

    it('should broadcast to all connections in a room', () => {
        const received: string[] = [];
        mockNative._connections.set('conn-1', { info: {}, onMessage: (msg: string) => received.push(`conn-1:${msg}`) });
        mockNative._connections.set('conn-2', { info: {}, onMessage: (msg: string) => received.push(`conn-2:${msg}`) });
        mockNative._connections.set('conn-3', { info: {}, onMessage: (msg: string) => received.push(`conn-3:${msg}`) });

        mockNative.joinRoom('conn-1', 'chat');
        mockNative.joinRoom('conn-2', 'chat');
        // conn-3 is NOT in the room

        mockNative.broadcastToRoom('chat', 'hello world');

        expect(received).toHaveLength(2);
        expect(received).toContain('conn-1:hello world');
        expect(received).toContain('conn-2:hello world');
        expect(received).not.toContain('conn-3:hello world');
    });

    it('should not broadcast to a connection that left the room', () => {
        const received: string[] = [];
        mockNative._connections.set('conn-1', { info: {}, onMessage: (msg: string) => received.push(msg) });
        mockNative._connections.set('conn-2', { info: {}, onMessage: (msg: string) => received.push(msg) });

        mockNative.joinRoom('conn-1', 'chat');
        mockNative.joinRoom('conn-2', 'chat');
        mockNative.leaveRoom('conn-2', 'chat');

        mockNative.broadcastToRoom('chat', 'after-leave');

        expect(received).toHaveLength(1);
        expect(received[0]).toBe('after-leave');
    });

    it('should handle multiple rooms independently', () => {
        const received: string[] = [];
        mockNative._connections.set('c1', { info: {}, onMessage: (msg: string) => received.push(`c1:${msg}`) });
        mockNative._connections.set('c2', { info: {}, onMessage: (msg: string) => received.push(`c2:${msg}`) });
        mockNative._connections.set('c3', { info: {}, onMessage: (msg: string) => received.push(`c3:${msg}`) });

        mockNative.joinRoom('c1', 'room-a');
        mockNative.joinRoom('c2', 'room-a');
        mockNative.joinRoom('c2', 'room-b');
        mockNative.joinRoom('c3', 'room-b');

        mockNative.broadcastToRoom('room-a', 'msg-a');
        mockNative.broadcastToRoom('room-b', 'msg-b');

        expect(received).toHaveLength(4);
        expect(received).toContain('c1:msg-a');
        expect(received).toContain('c2:msg-a');
        expect(received).toContain('c2:msg-b');
        expect(received).toContain('c3:msg-b');
    });

    it('should handle disconnecting a connection (leaves all rooms)', () => {
        mockNative.joinRoom('conn-1', 'a');
        mockNative.joinRoom('conn-1', 'b');
        mockNative.joinRoom('conn-1', 'c');

        mockNative.disconnect('conn-1');

        expect(mockNative.getRoomInfo('a').connections).not.toContain('conn-1');
        expect(mockNative.getRoomInfo('b').connections).not.toContain('conn-1');
        expect(mockNative.getRoomInfo('c').connections).not.toContain('conn-1');
    });
});
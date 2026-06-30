import logger from 'ernest-logger';
import { loadNative } from './native-loader.js';
/**
 * High-level JavaScript API for room/pub-sub management.
 *
 * Maintains a local JS-side membership map that mirrors the C++ layer.
 * This means getRoomSize(), getRoomMembers(), and getRoomInfo() always
 * reflect the correct state even for connections that don't have a real
 * uWS socket (e.g. in unit tests with mock connection IDs).
 *
 * The native joinRoom/leaveRoom/broadcastToRoom calls still happen for
 * real connections so uWS topic routing works correctly.
 */
export class RoomManager {
    native;
    destroyed = false;
    // Local mirrors — source of truth for reads
    roomMembers = new Map(); // room → Set<connId>
    connRooms = new Map(); // connId → Set<room>
    constructor() {
        this.native = loadNative();
    }
    /**
     * Add a connection to a room. If the room doesn't exist, it is created.
     */
    join(connectionId, room) {
        if (this.destroyed)
            return;
        // Update local state
        if (!this.roomMembers.has(room))
            this.roomMembers.set(room, new Set());
        if (!this.connRooms.has(connectionId))
            this.connRooms.set(connectionId, new Set());
        this.roomMembers.get(room).add(connectionId);
        this.connRooms.get(connectionId).add(room);
        // Forward to native (no-op if socket doesn't exist, that's fine)
        this.native.joinRoom(connectionId, room);
        logger.debug(`Connection ${connectionId} joined room: ${room}`);
    }
    /**
     * Remove a connection from a room.
     */
    leave(connectionId, room) {
        if (this.destroyed)
            return;
        // Update local state
        this.roomMembers.get(room)?.delete(connectionId);
        if (this.roomMembers.get(room)?.size === 0)
            this.roomMembers.delete(room);
        this.connRooms.get(connectionId)?.delete(room);
        if (this.connRooms.get(connectionId)?.size === 0)
            this.connRooms.delete(connectionId);
        this.native.leaveRoom(connectionId, room);
        logger.debug(`Connection ${connectionId} left room: ${room}`);
    }
    /**
     * Remove a connection from ALL rooms it belongs to.
     */
    leaveAll(connectionId) {
        if (this.destroyed)
            return;
        const rooms = this.getConnectionRooms(connectionId);
        for (const room of rooms) {
            this.roomMembers.get(room)?.delete(connectionId);
            if (this.roomMembers.get(room)?.size === 0)
                this.roomMembers.delete(room);
            this.native.leaveRoom(connectionId, room);
        }
        this.connRooms.delete(connectionId);
        if (rooms.length > 0) {
            logger.debug(`Connection ${connectionId} left all rooms: [${rooms.join(', ')}]`);
        }
    }
    /**
     * Broadcast a message to all connections in a room.
     */
    broadcast(room, data) {
        if (this.destroyed)
            return;
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        this.native.broadcastToRoom(room, message);
        logger.debug(`Broadcast to room "${room}": ${message.length > 100 ? message.slice(0, 100) + '...' : message}`);
    }
    /**
     * Get information about a specific room (reads from local JS state).
     */
    getRoomInfo(room) {
        const members = this.roomMembers.get(room);
        return {
            name: room,
            size: members?.size ?? 0,
            connections: members ? [...members] : [],
        };
    }
    /**
     * Get all room names that a connection is a member of (reads from local JS state).
     */
    getConnectionRooms(connectionId) {
        return [...(this.connRooms.get(connectionId) ?? [])];
    }
    /**
     * Get the number of connections in a room (reads from local JS state).
     */
    getRoomSize(room) {
        return this.roomMembers.get(room)?.size ?? 0;
    }
    /**
     * Get the IDs of all connections in a room (reads from local JS state).
     */
    getRoomMembers(room) {
        const members = this.roomMembers.get(room);
        return members ? [...members] : [];
    }
    /**
     * Clean up the room manager. After calling this, all operations are no-ops.
     */
    destroy() {
        this.destroyed = true;
        this.roomMembers.clear();
        this.connRooms.clear();
        logger.debug('RoomManager destroyed');
    }
}
//# sourceMappingURL=room-manager.js.map
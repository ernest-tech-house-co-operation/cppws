import logger from 'ernest-logger';
import { loadNative } from './native-loader.js';
export class RoomManager {
    native;
    destroyed = false;
    roomMembers = new Map();
    connRooms = new Map();
    pendingJoins = new Map();
    constructor() {
        this.native = loadNative();
        logger.debug('[RoomManager] constructed');
    }
    _handleJoinConfirm(connectionId, room) {
        const key = `${connectionId}:${room}`;
        const resolve = this.pendingJoins.get(key);
        logger.debug(`[RoomManager] _handleJoinConfirm called key=${key} found=${!!resolve} ` +
            `currentPendingKeys=[${[...this.pendingJoins.keys()].join(', ')}]`);
        if (resolve) {
            this.pendingJoins.delete(key);
            resolve();
            logger.debug(`[RoomManager] _handleJoinConfirm RESOLVED key=${key}`);
        }
        else {
            logger.debug(`[RoomManager] _handleJoinConfirm NO MATCHING PENDING JOIN for key=${key} (already resolved? or never registered?)`);
        }
    }
    join(connectionId, room) {
        logger.debug(`[RoomManager] join() called connectionId=${connectionId} room=${room} destroyed=${this.destroyed}`);
        if (this.destroyed) {
            logger.debug('[RoomManager] join() short-circuit: manager destroyed');
            return Promise.resolve();
        }
        if (!this.roomMembers.has(room))
            this.roomMembers.set(room, new Set());
        if (!this.connRooms.has(connectionId))
            this.connRooms.set(connectionId, new Set());
        this.roomMembers.get(room).add(connectionId);
        this.connRooms.get(connectionId).add(room);
        const nativeRunning = this.native.isRunning();
        logger.debug(`[RoomManager] join() native.isRunning()=${nativeRunning}`);
        // Fall back to fire-and-forget only if there's no real server running
        // (unit tests, JS mock). NOTE: no longer checking setOnJoinConfirmed —
        // that method was removed when we migrated to the __joinConfirmed:
        // message-prefix approach (Fix 5). Checking for it here would ALWAYS
        // be true post-removal and silently skip the await path. Ask me how
        // I know.
        if (!nativeRunning) {
            this.native.joinRoom(connectionId, room);
            logger.debug(`[RoomManager] join() fire-and-forget path: ${connectionId} -> ${room} (no server running)`);
            return Promise.resolve();
        }
        const key = `${connectionId}:${room}`;
        logger.debug(`[RoomManager] join() AWAIT path: registering pendingJoins key=${key}`);
        return new Promise(resolve => {
            this.pendingJoins.set(key, resolve);
            this.native.joinRoom(connectionId, room);
            logger.debug(`[RoomManager] join() native.joinRoom(${connectionId}, ${room}) called, Promise pending on key=${key}`);
        });
    }
    leave(connectionId, room) {
        if (this.destroyed)
            return;
        logger.debug(`[RoomManager] leave() connectionId=${connectionId} room=${room}`);
        this.roomMembers.get(room)?.delete(connectionId);
        if (this.roomMembers.get(room)?.size === 0)
            this.roomMembers.delete(room);
        this.connRooms.get(connectionId)?.delete(room);
        if (this.connRooms.get(connectionId)?.size === 0)
            this.connRooms.delete(connectionId);
        this.native.leaveRoom(connectionId, room);
        logger.debug(`Connection ${connectionId} left room: ${room}`);
    }
    leaveAll(connectionId) {
        if (this.destroyed)
            return;
        const rooms = this.getConnectionRooms(connectionId);
        logger.debug(`[RoomManager] leaveAll() connectionId=${connectionId} rooms=[${rooms.join(', ')}]`);
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
    broadcast(room, data) {
        if (this.destroyed)
            return;
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        logger.debug(`[RoomManager] broadcast() room=${room} size=${message.length}`);
        this.native.broadcastToRoom(room, message);
        logger.debug(`Broadcast to room "${room}": ${message.length > 100 ? message.slice(0, 100) + '...' : message}`);
    }
    getRoomInfo(room) {
        const members = this.roomMembers.get(room);
        return {
            name: room,
            size: members?.size ?? 0,
            connections: members ? [...members] : [],
        };
    }
    getConnectionRooms(connectionId) {
        return [...(this.connRooms.get(connectionId) ?? [])];
    }
    getRoomSize(room) {
        return this.roomMembers.get(room)?.size ?? 0;
    }
    getRoomMembers(room) {
        const members = this.roomMembers.get(room);
        return members ? [...members] : [];
    }
    cancelPendingJoins(connectionId) {
        const matching = [...this.pendingJoins.keys()].filter(k => k.startsWith(`${connectionId}:`));
        logger.debug(`[RoomManager] cancelPendingJoins() connectionId=${connectionId} matchingKeys=[${matching.join(', ')}]`);
        for (const key of matching) {
            this.pendingJoins.get(key)();
            this.pendingJoins.delete(key);
            logger.debug(`Cancelled pending join for key: ${key}`);
        }
    }
    destroy() {
        if (this.destroyed)
            return;
        logger.debug(`[RoomManager] destroy() flushing ${this.pendingJoins.size} pending join(s)`);
        this.destroyed = true;
        for (const resolve of this.pendingJoins.values())
            resolve();
        this.pendingJoins.clear();
        this.roomMembers.clear();
        this.connRooms.clear();
        logger.debug('RoomManager destroyed');
    }
}
//# sourceMappingURL=room-manager.js.map
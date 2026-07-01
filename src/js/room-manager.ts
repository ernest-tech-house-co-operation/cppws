import logger from 'ernest-logger';
import { loadNative } from './native-loader.js';

export interface RoomInfo {
    name: string;
    size: number;
    connections: string[];
}

export class RoomManager {
    private native: ReturnType<typeof loadNative>;
    private destroyed = false;

    private roomMembers = new Map<string, Set<string>>();
    private connRooms   = new Map<string, Set<string>>();
    private pendingJoins = new Map<string, () => void>();

    constructor() {
        this.native = loadNative();
    }

    _handleJoinConfirm(connectionId: string, room: string): void {
        const key = `${connectionId}:${room}`;
        const resolve = this.pendingJoins.get(key);
        if (resolve) {
            this.pendingJoins.delete(key);
            resolve();
        }
    }

    join(connectionId: string, room: string): Promise<void> {
        if (this.destroyed) return Promise.resolve();

        if (!this.roomMembers.has(room)) this.roomMembers.set(room, new Set());
        if (!this.connRooms.has(connectionId)) this.connRooms.set(connectionId, new Set());
        this.roomMembers.get(room)!.add(connectionId);
        this.connRooms.get(connectionId)!.add(room);

        // Fall back to fire-and-forget if no server running (unit tests, JS mock)
        if (typeof (this.native as any).setOnJoinConfirmed !== 'function'
            || !this.native.isRunning()) {
            this.native.joinRoom(connectionId, room);
            logger.debug(`Connection ${connectionId} joined room: ${room}`);
            return Promise.resolve();
        }

        return new Promise<void>(resolve => {
            const key = `${connectionId}:${room}`;
            this.pendingJoins.set(key, resolve);
            this.native.joinRoom(connectionId, room);
            logger.debug(`Connection ${connectionId} joining room: ${room} (awaiting C++ confirm)`);
        });
    }

    leave(connectionId: string, room: string): void {
        if (this.destroyed) return;
        this.roomMembers.get(room)?.delete(connectionId);
        if (this.roomMembers.get(room)?.size === 0) this.roomMembers.delete(room);
        this.connRooms.get(connectionId)?.delete(room);
        if (this.connRooms.get(connectionId)?.size === 0) this.connRooms.delete(connectionId);
        this.native.leaveRoom(connectionId, room);
        logger.debug(`Connection ${connectionId} left room: ${room}`);
    }

    leaveAll(connectionId: string): void {
        if (this.destroyed) return;
        const rooms = this.getConnectionRooms(connectionId);
        for (const room of rooms) {
            this.roomMembers.get(room)?.delete(connectionId);
            if (this.roomMembers.get(room)?.size === 0) this.roomMembers.delete(room);
            this.native.leaveRoom(connectionId, room);
        }
        this.connRooms.delete(connectionId);
        if (rooms.length > 0) {
            logger.debug(`Connection ${connectionId} left all rooms: [${rooms.join(', ')}]`);
        }
    }

    broadcast(room: string, data: unknown): void {
        if (this.destroyed) return;
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        this.native.broadcastToRoom(room, message);
        logger.debug(`Broadcast to room "${room}": ${message.length > 100 ? message.slice(0, 100) + '...' : message}`);
    }

    getRoomInfo(room: string): RoomInfo {
        const members = this.roomMembers.get(room);
        return {
            name:        room,
            size:        members?.size ?? 0,
            connections: members ? [...members] : [],
        };
    }

    getConnectionRooms(connectionId: string): string[] {
        return [...(this.connRooms.get(connectionId) ?? [])];
    }

    getRoomSize(room: string): number {
        return this.roomMembers.get(room)?.size ?? 0;
    }

    getRoomMembers(room: string): string[] {
        const members = this.roomMembers.get(room);
        return members ? [...members] : [];
    }

    cancelPendingJoins(connectionId: string): void {
        for (const key of [...this.pendingJoins.keys()]) {
            if (key.startsWith(`${connectionId}:`)) {
                this.pendingJoins.get(key)!();
                this.pendingJoins.delete(key);
                logger.debug(`Cancelled pending join for key: ${key}`);
            }
        }
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const resolve of this.pendingJoins.values()) resolve();
        this.pendingJoins.clear();
        this.roomMembers.clear();
        this.connRooms.clear();
        logger.debug('RoomManager destroyed');
    }
}
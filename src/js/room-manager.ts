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

    // Keyed by "connectionId:room" → resolve function
    private pendingJoins = new Map<string, () => void>();

    constructor() {
        this.native = loadNative();
        // DO NOT wire setOnJoinConfirmed here — it will be wiped by configure().
        // Wiring happens in WebSocketServer.initialize() after configure().
    }

    /**
     * Called by C++ via the JS TSFN after ws->subscribe() completes.
     * Resolves the pending join Promise.
     */
    _handleJoinConfirm(connectionId: string, room: string): void {
        const key = `${connectionId}:${room}`;
        const resolve = this.pendingJoins.get(key);
        if (resolve) {
            this.pendingJoins.delete(key);
            resolve();
            logger.debug(`Join confirmed for ${connectionId} -> ${room}`);
        } else {
            logger.warn(`No pending join for key: ${key}`);
        }
    }

    join(connectionId: string, room: string): Promise<void> {
        if (this.destroyed) return Promise.resolve();

        // Update local JS state immediately
        if (!this.roomMembers.has(room)) this.roomMembers.set(room, new Set());
        if (!this.connRooms.has(connectionId)) this.connRooms.set(connectionId, new Set());
        this.roomMembers.get(room)!.add(connectionId);
        this.connRooms.get(connectionId)!.add(room);

        // If native doesn't support confirmed joins (JS mock), fall back.
        if (typeof (this.native as any).setOnJoinConfirmed !== 'function') {
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

    // leave(), leaveAll(), broadcast(), etc. unchanged...

    cancelPendingJoins(connectionId: string): void {
        const toRemove: string[] = [];
        for (const key of this.pendingJoins.keys()) {
            if (key.startsWith(`${connectionId}:`)) {
                toRemove.push(key);
            }
        }
        for (const key of toRemove) {
            const resolve = this.pendingJoins.get(key);
            if (resolve) {
                this.pendingJoins.delete(key);
                resolve();
                logger.debug(`Cancelled pending join for key: ${key}`);
            }
        }
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        for (const resolve of this.pendingJoins.values()) {
            resolve();
        }
        this.pendingJoins.clear();
        this.roomMembers.clear();
        this.connRooms.clear();
        logger.debug('RoomManager destroyed');
    }
}
export interface RoomInfo {
    name: string;
    size: number;
    connections: string[];
}
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
export declare class RoomManager {
    private native;
    private destroyed;
    private roomMembers;
    private connRooms;
    constructor();
    /**
     * Add a connection to a room. If the room doesn't exist, it is created.
     */
    join(connectionId: string, room: string): void;
    /**
     * Remove a connection from a room.
     */
    leave(connectionId: string, room: string): void;
    /**
     * Remove a connection from ALL rooms it belongs to.
     */
    leaveAll(connectionId: string): void;
    /**
     * Broadcast a message to all connections in a room.
     */
    broadcast(room: string, data: unknown): void;
    /**
     * Get information about a specific room (reads from local JS state).
     */
    getRoomInfo(room: string): RoomInfo;
    /**
     * Get all room names that a connection is a member of (reads from local JS state).
     */
    getConnectionRooms(connectionId: string): string[];
    /**
     * Get the number of connections in a room (reads from local JS state).
     */
    getRoomSize(room: string): number;
    /**
     * Get the IDs of all connections in a room (reads from local JS state).
     */
    getRoomMembers(room: string): string[];
    /**
     * Clean up the room manager. After calling this, all operations are no-ops.
     */
    destroy(): void;
}
//# sourceMappingURL=room-manager.d.ts.map
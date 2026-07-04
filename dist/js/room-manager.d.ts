export interface RoomInfo {
    name: string;
    size: number;
    connections: string[];
}
export declare class RoomManager {
    private native;
    private destroyed;
    private roomMembers;
    private connRooms;
    private pendingJoins;
    constructor();
    _handleJoinConfirm(connectionId: string, room: string): void;
    join(connectionId: string, room: string): Promise<void>;
    leave(connectionId: string, room: string): void;
    leaveAll(connectionId: string): void;
    broadcast(room: string, data: unknown): void;
    getRoomInfo(room: string): RoomInfo;
    getConnectionRooms(connectionId: string): string[];
    getRoomSize(room: string): number;
    getRoomMembers(room: string): string[];
    cancelPendingJoins(connectionId: string): void;
    destroy(): void;
}
//# sourceMappingURL=room-manager.d.ts.map
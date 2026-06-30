import type { WSContext, WSOptions } from '../types/index.js';
import type { RoomManager } from './room-manager.js';
/**
 * Create a WSContext object for a given WebSocket connection.
 *
 * All sends go through the C++ native layer — no runtime API (Bun/Node/Deno)
 * is touched here. cppws owns the sockets via uWebSockets so broadcastToRoom,
 * sendToConnection, etc. all work identically on every runtime.
 */
export declare function createWSContext<T extends Record<string, any>>(connectionId: string, ip: string, nativeServer: any, options: WSOptions<T>, roomManager?: RoomManager): WSContext<T>;
//# sourceMappingURL=ws-context.d.ts.map
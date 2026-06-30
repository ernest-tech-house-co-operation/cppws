// Re-export shim for `import { ws } from 'cppws/plugin'`
export { ws, WebSocketServer } from './index.js';
export type {
    WSOptions,
    WSHandler,
    WSContext,
    WSMetrics,
    ServerEvents,
    ConnectionInfo,
    RoomConfig,
    SecurityConfig,
    CompressionConfig,
    PubSubAdapter,
    HistoryEntry,
    ReconnectState,
} from '../types/index.js';
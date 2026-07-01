#pragma once

#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <functional>
#include <mutex>
#include <shared_mutex>
#include <thread>
#include <queue>
#include <chrono>
#include <atomic>
#include <condition_variable>
#include <memory>
#include <napi.h>

namespace elysiacppws {

// ══════════════════════════════════════════════════════════════════════
//  Per-Socket Data  (stored inside each uWS WebSocket slot)
// ══════════════════════════════════════════════════════════════════════
struct PerSocketData {
    std::string connectionId;
    std::string ip;
    std::string userId;
    std::string path;
    std::chrono::steady_clock::time_point connectedAt;
    std::chrono::steady_clock::time_point lastSeen;
    uint64_t messagesReceived = 0;
};

// ══════════════════════════════════════════════════════════════════════
//  TSFN payload types  (heap-allocated, deleted inside the JS callback)
// ══════════════════════════════════════════════════════════════════════
struct OpenData {
    std::string connectionId;
    std::string ip;
    std::string userId;
    std::string path;
};

struct MessageData {
    std::string connectionId;
    std::string message;
    size_t      bytes;
};

struct CloseData {
    std::string connectionId;
    int         code;
    std::string reason;
};

struct DrainData {
    std::string connectionId;
};

// ── NEW: confirmation payload for JOIN_ROOM ──────────────────────────
struct JoinConfirmData {
    std::string connectionId;
    std::string room;
};

// ══════════════════════════════════════════════════════════════════════
//  Async operation queue  (JS thread → uWS thread)
// ══════════════════════════════════════════════════════════════════════
enum class OpType {
    SEND_TO_CONNECTION,
    BROADCAST_TO_ROOM,
    JOIN_ROOM,
    LEAVE_ROOM,
    DISCONNECT,
    SHUTDOWN,
};

struct PendingOp {
    OpType      type;
    std::string arg1;
    std::string arg2;
};

// ══════════════════════════════════════════════════════════════════════
//  Connection Metadata
// ══════════════════════════════════════════════════════════════════════
struct ConnectionInfo {
    std::string id;
    std::string ip;
    std::vector<std::string> rooms;
    std::string userId;
    std::chrono::steady_clock::time_point connectedAt;
    std::chrono::steady_clock::time_point lastSeen;
    uint64_t messagesReceived = 0;
    uint64_t messagesSent     = 0;
    uint64_t bytesReceived    = 0;
    uint64_t bytesSent        = 0;
};

// ══════════════════════════════════════════════════════════════════════
//  RateLimiter
// ══════════════════════════════════════════════════════════════════════
class RateLimiter {
public:
    RateLimiter(int maxMessagesPerMinute, int maxPayloadBytes);

    bool checkRateLimit(const std::string& connectionId);
    bool checkPayloadSize(size_t payloadSize);
    void resetConnection(const std::string& connectionId);
    int  getDroppedCount(const std::string& connectionId) const;

private:
    struct SlidingWindow {
        std::vector<std::chrono::steady_clock::time_point> timestamps;
    };
    int                                             maxPerMinute_;
    int                                             maxPayloadBytes_;
    mutable std::mutex                              mutex_;
    std::unordered_map<std::string, SlidingWindow>  windows_;
    std::unordered_map<std::string, int>            droppedCounts_;
};

// ══════════════════════════════════════════════════════════════════════
//  RoomManager  (metadata only — uWS topics do the actual routing)
// ══════════════════════════════════════════════════════════════════════
class RoomManager {
public:
    void join(const std::string& connectionId, const std::string& room);
    void leave(const std::string& connectionId, const std::string& room);
    void leaveAll(const std::string& connectionId);
    void broadcast(const std::string& room, const std::string& message); // no-op stub
    std::vector<std::string> getRooms(const std::string& connectionId) const;
    std::vector<std::string> getConnectionsInRoom(const std::string& room) const;
    size_t getRoomSize(const std::string& room) const;
    size_t getTotalRooms() const;

private:
    mutable std::mutex mutex_;
    std::unordered_map<std::string, std::unordered_set<std::string>> roomMembers_;
    std::unordered_map<std::string, std::unordered_set<std::string>> connectionRooms_;
};

// ══════════════════════════════════════════════════════════════════════
//  BackpressureManager
// ══════════════════════════════════════════════════════════════════════
class BackpressureManager {
public:
    explicit BackpressureManager(size_t highWaterMark = 1024 * 1024);

    bool   canWrite(const std::string& connectionId, size_t pendingBytes);
    void   onDrain(const std::string& connectionId);
    size_t getPendingBytes(const std::string& connectionId) const;
    void   removeConnection(const std::string& connectionId);

private:
    size_t                                        highWaterMark_;
    mutable std::mutex                            mutex_;
    std::unordered_map<std::string, size_t>       pendingBytes_;
};

// ══════════════════════════════════════════════════════════════════════
//  ConnectionThrottler  (per-IP)
// ══════════════════════════════════════════════════════════════════════
class ConnectionThrottler {
public:
    explicit ConnectionThrottler(int maxConnectionsPerIP = 10);

    bool allowConnection(const std::string& ip);
    void removeConnection(const std::string& ip);
    int  getConnectionCount(const std::string& ip) const;

private:
    int                                     maxPerIP_;
    mutable std::mutex                      mutex_;
    std::unordered_map<std::string, int>    ipCounts_;
};

// ══════════════════════════════════════════════════════════════════════
//  ServerMetrics  (all atomic — safe to read from any thread)
// ══════════════════════════════════════════════════════════════════════
struct ServerMetrics {
    std::atomic<uint64_t> totalConnections{0};
    std::atomic<uint64_t> activeConnections{0};
    std::atomic<uint64_t> totalMessagesReceived{0};
    std::atomic<uint64_t> totalMessagesSent{0};
    std::atomic<uint64_t> totalBytesReceived{0};
    std::atomic<uint64_t> totalBytesSent{0};
    std::atomic<uint64_t> droppedMessages{0};
    std::atomic<uint64_t> rejectedConnections{0};
    std::chrono::steady_clock::time_point startedAt;
};

// ══════════════════════════════════════════════════════════════════════
//  BroadcastHistory  (event-sourcing / replay support)
// ══════════════════════════════════════════════════════════════════════
struct HistoryEntry {
    std::string room;
    std::string message;
    int64_t     timestamp;
    std::string messageId;
};

class BroadcastHistory {
public:
    explicit BroadcastHistory(size_t maxEntriesPerRoom = 100);

    void store(const std::string& room, const std::string& message,
               const std::string& messageId);
    std::vector<HistoryEntry> getSince(const std::string& room,
                                       int64_t sinceTimestamp) const;
    HistoryEntry getLast(const std::string& room) const;
    void prune();

private:
    size_t                                                        maxEntries_;
    mutable std::mutex                                            mutex_;
    std::unordered_map<std::string, std::vector<HistoryEntry>>    history_;
};

// ══════════════════════════════════════════════════════════════════════
//  WebSocketServer  (N-API ObjectWrap)
// ══════════════════════════════════════════════════════════════════════
class WebSocketServer : public Napi::ObjectWrap<WebSocketServer> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    explicit WebSocketServer(const Napi::CallbackInfo& info);
    ~WebSocketServer();

    // ── Lifecycle ──────────────────────────────────────────────────
    Napi::Value start(const Napi::CallbackInfo& info);
    Napi::Value stop(const Napi::CallbackInfo& info);
    Napi::Value isRunning(const Napi::CallbackInfo& info);

    // ── Room operations ────────────────────────────────────────────
    Napi::Value joinRoom(const Napi::CallbackInfo& info);
    Napi::Value leaveRoom(const Napi::CallbackInfo& info);
    Napi::Value broadcastToRoom(const Napi::CallbackInfo& info);
    Napi::Value getRoomInfo(const Napi::CallbackInfo& info);

    // ── Direct messaging ───────────────────────────────────────────
    Napi::Value sendToConnection(const Napi::CallbackInfo& info);
    Napi::Value sendToUser(const Napi::CallbackInfo& info);

    // ── Connection management ──────────────────────────────────────
    Napi::Value disconnect(const Napi::CallbackInfo& info);
    Napi::Value getConnectionCount(const Napi::CallbackInfo& info);
    Napi::Value getConnectionInfo(const Napi::CallbackInfo& info);

    // ── Metrics ────────────────────────────────────────────────────
    Napi::Value getMetrics(const Napi::CallbackInfo& info);

    // ── Configuration ──────────────────────────────────────────────
    Napi::Value configure(const Napi::CallbackInfo& info);

    // ── History ────────────────────────────────────────────────────
    Napi::Value getHistory(const Napi::CallbackInfo& info);

    // ── NEW: set confirmation callback for join operations ────────
    Napi::Value setOnJoinConfirmed(const Napi::CallbackInfo& info);

private:
    // ── Server config ──────────────────────────────────────────────
    std::string host_               = "0.0.0.0";
    int         port_               = 3000;
    bool        tlsEnabled_         = false;
    std::string certPath_;
    std::string keyPath_;
    bool        compressionEnabled_ = false;
    int         compressionLevel_   = 3;
    int         idleTimeoutSeconds_ = 120;
    int         maxPayloadBytes_    = 1024 * 1024; // 1 MB
    size_t      highWaterMark_      = 1024 * 1024; // 1 MB

    // ── Runtime state ──────────────────────────────────────────────
    std::atomic<bool>   running_{false};
    void*               app_   = nullptr;
    void*               async_ = nullptr;
    void*               listenSocket_ = nullptr;
    std::thread         wsThread_;

    // ── Socket registry  (socketMutex_ guards sockets_) ───────────
    mutable std::shared_mutex                       socketMutex_;
    std::unordered_map<std::string, void*>          sockets_;

    // ── Sub-components ─────────────────────────────────────────────
    std::unique_ptr<RoomManager>          roomManager_;
    std::unique_ptr<RateLimiter>          rateLimiter_;
    std::unique_ptr<BackpressureManager>  backpressureManager_;
    std::unique_ptr<ConnectionThrottler>  connectionThrottler_;
    std::unique_ptr<BroadcastHistory>     broadcastHistory_;
    ServerMetrics                         metrics_;

    // ── User/connection maps  (userMapMutex_ guards both) ─────────
    mutable std::mutex                              userMapMutex_;
    std::unordered_map<std::string, std::string>    userToConnection_;
    std::unordered_map<std::string, ConnectionInfo> connections_;

    // ── JS callbacks ───────────────────────────────────────────────
    Napi::ThreadSafeFunction onOpenCallback_;
    Napi::ThreadSafeFunction onMessageCallback_;
    Napi::ThreadSafeFunction onCloseCallback_;
    Napi::ThreadSafeFunction onDrainCallback_;
    Napi::ThreadSafeFunction onUpgradeCallback_;

    // ── NEW: confirmation callback for joins ──────────────────────
    Napi::ThreadSafeFunction onJoinConfirmedCallback_;

    // ── Async op queue  (JS thread enqueues, uWS thread drains) ───
    mutable std::mutex      pendingMutex_;
    std::queue<PendingOp>   pendingOps_;

    // ── Private helpers ────────────────────────────────────────────
    std::string generateConnectionId();
    std::mutex              loopReadyMutex_;
    std::condition_variable loopReadyCv_;
    std::mutex stopMutex_;
    std::atomic<bool> stopped_{false};
    void        registerCallbacks(const Napi::CallbackInfo& info);
    void        cleanupConnection(const std::string& connectionId);
    void        enqueueOp(OpType type,
                          const std::string& arg1,
                          const std::string& arg2);
    void        executePendingOperations();
    void        runServer();   // runs on wsThread_
};

} // namespace elysiacppws
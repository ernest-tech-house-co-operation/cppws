#include "websocket_core.h"

// uWS must be included AFTER our header (which forward-declares the types).
// CMake provides the include path to the uWebSockets/src/ directory.
#include "App.h"

#include <random>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cstring>
#include <mutex>      // for stopMutex_
#include <atomic>     // for stopped_

namespace elysiacppws {

// Convenience alias — matches the template params in the header forward-decl.
using NativeWS = uWS::WebSocket<false, true, PerSocketData>;
using NativeApp = uWS::App;

// ══════════════════════════════════════════════════════════════════════
//  Utility
// ══════════════════════════════════════════════════════════════════════

namespace {

std::string randomHex(size_t numBytes) {
    static thread_local std::mt19937_64 rng(
        static_cast<unsigned>(
            std::hash<std::thread::id>{}(std::this_thread::get_id()))
        ^ static_cast<unsigned long long>(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    std::uniform_int_distribution<uint64_t> dist;
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    size_t fullWords = (numBytes + 7) / 8;
    for (size_t i = 0; i < fullWords; ++i) {
        oss << std::setw(16) << dist(rng);
    }
    std::string result = oss.str();
    // FIX #4 (minor): trim from the front to keep the most-significant
    // (most uniformly distributed) bits, not the tail.
    if (result.size() > numBytes * 2) {
        result = result.substr(0, numBytes * 2);
    }
    return result;
}

int64_t nowMillis() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// FIX #4: Robust IP extraction that handles IPv4, IPv4-mapped IPv6,
// bracketed IPv6 (e.g. [::1]:port), and bare IPv6 addresses correctly.
std::string extractIP(auto* res, auto* req) {
    // Prefer explicit forwarding headers
    std::string_view xff = req->getHeader("x-forwarded-for");
    if (!xff.empty()) {
        auto comma = xff.find(',');
        // Trim leading whitespace from first entry
        std::string_view first = xff.substr(0, comma != std::string_view::npos ? comma : xff.size());
        size_t start = first.find_first_not_of(' ');
        return std::string(start != std::string_view::npos ? first.substr(start) : first);
    }

    std::string_view realIP = req->getHeader("x-real-ip");
    if (!realIP.empty()) return std::string(realIP);

    // FIX: getRemoteAddress()/getRemoteAddressAsText() live on HttpResponse,
    // not HttpRequest — uWS exposes them on the response/socket object.
    // ...AsText() already returns plain text with no port suffix, so the
    // bracket/colon parsing below is just defensive for any other source.
    std::string_view addr = res->getRemoteAddressAsText();
    if (addr.empty()) return "unknown";

    // Bracketed IPv6: [::1]:port
    if (addr.front() == '[') {
        auto close = addr.find(']');
        if (close != std::string_view::npos) {
            return std::string(addr.substr(1, close - 1));
        }
    }

    // IPv4 or IPv4-mapped: "1.2.3.4:port" — rfind(':') is safe
    // because IPv4 addresses contain no colons except before the port.
    auto colon = addr.rfind(':');
    if (colon != std::string_view::npos) {
        // Count colons: >1 means bare IPv6, no port suffix
        size_t colonCount = std::count(addr.begin(), addr.end(), ':');
        if (colonCount == 1) {
            // IPv4:port
            return std::string(addr.substr(0, colon));
        }
    }

    // Bare IPv6 or anything else — return as-is
    return std::string(addr);
}

} // anonymous namespace

// ══════════════════════════════════════════════════════════════════════
//  RateLimiter
// ══════════════════════════════════════════════════════════════════════

RateLimiter::RateLimiter(int maxMessagesPerMinute, int maxPayloadBytes)
    : maxPerMinute_(maxMessagesPerMinute)
    , maxPayloadBytes_(maxPayloadBytes) {}

bool RateLimiter::checkRateLimit(const std::string& connectionId) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto now = std::chrono::steady_clock::now();
    auto cutoff = now - std::chrono::seconds(60);
    auto& sw = windows_[connectionId];
    sw.timestamps.erase(
        std::remove_if(sw.timestamps.begin(), sw.timestamps.end(),
            [&](const auto& tp) { return tp < cutoff; }),
        sw.timestamps.end());
    if (static_cast<int>(sw.timestamps.size()) >= maxPerMinute_) {
        droppedCounts_[connectionId]++;
        return false;
    }
    sw.timestamps.push_back(now);
    return true;
}

bool RateLimiter::checkPayloadSize(size_t payloadSize) {
    return static_cast<int>(payloadSize) <= maxPayloadBytes_;
}

void RateLimiter::resetConnection(const std::string& connectionId) {
    std::lock_guard<std::mutex> lock(mutex_);
    windows_.erase(connectionId);
    droppedCounts_.erase(connectionId);
}

int RateLimiter::getDroppedCount(const std::string& connectionId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = droppedCounts_.find(connectionId);
    return (it != droppedCounts_.end()) ? it->second : 0;
}

// ══════════════════════════════════════════════════════════════════════
//  RoomManager  (metadata only; uWS topics handle actual routing)
// ══════════════════════════════════════════════════════════════════════

void RoomManager::join(const std::string& connectionId, const std::string& room) {
    std::lock_guard<std::mutex> lock(mutex_);
    roomMembers_[room].insert(connectionId);
    connectionRooms_[connectionId].insert(room);
}

void RoomManager::leave(const std::string& connectionId, const std::string& room) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto roomIt = roomMembers_.find(room);
    if (roomIt != roomMembers_.end()) {
        roomIt->second.erase(connectionId);
        if (roomIt->second.empty()) roomMembers_.erase(roomIt);
    }
    auto connIt = connectionRooms_.find(connectionId);
    if (connIt != connectionRooms_.end()) {
        connIt->second.erase(room);
        if (connIt->second.empty()) connectionRooms_.erase(connIt);
    }
}

void RoomManager::leaveAll(const std::string& connectionId) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto connIt = connectionRooms_.find(connectionId);
    if (connIt == connectionRooms_.end()) return;
    auto rooms = connIt->second;
    for (const auto& room : rooms) {
        auto roomIt = roomMembers_.find(room);
        if (roomIt != roomMembers_.end()) {
            roomIt->second.erase(connectionId);
            if (roomIt->second.empty()) roomMembers_.erase(roomIt);
        }
    }
    connectionRooms_.erase(connIt);
}

void RoomManager::broadcast(const std::string& /*room*/, const std::string& /*message*/) {
    // Actual broadcasting goes through uWS::App::publish() in executePendingOperations().
    // This metadata-only RoomManager just tracks membership.
}

std::vector<std::string> RoomManager::getRooms(const std::string& connectionId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = connectionRooms_.find(connectionId);
    if (it != connectionRooms_.end())
        return std::vector<std::string>(it->second.begin(), it->second.end());
    return {};
}

std::vector<std::string> RoomManager::getConnectionsInRoom(const std::string& room) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = roomMembers_.find(room);
    if (it != roomMembers_.end())
        return std::vector<std::string>(it->second.begin(), it->second.end());
    return {};
}

size_t RoomManager::getRoomSize(const std::string& room) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = roomMembers_.find(room);
    return (it != roomMembers_.end()) ? it->second.size() : 0;
}

size_t RoomManager::getTotalRooms() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return roomMembers_.size();
}

// ══════════════════════════════════════════════════════════════════════
//  BackpressureManager
// ══════════════════════════════════════════════════════════════════════

BackpressureManager::BackpressureManager(size_t highWaterMark)
    : highWaterMark_(highWaterMark) {}

bool BackpressureManager::canWrite(const std::string& connectionId, size_t pendingBytes) {
    std::lock_guard<std::mutex> lock(mutex_);
    size_t current = pendingBytes_[connectionId];
    if (current + pendingBytes > highWaterMark_) return false;
    pendingBytes_[connectionId] = current + pendingBytes;
    return true;
}

void BackpressureManager::onDrain(const std::string& connectionId) {
    std::lock_guard<std::mutex> lock(mutex_);
    pendingBytes_[connectionId] = 0;
}

size_t BackpressureManager::getPendingBytes(const std::string& connectionId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = pendingBytes_.find(connectionId);
    return (it != pendingBytes_.end()) ? it->second : 0;
}

void BackpressureManager::removeConnection(const std::string& connectionId) {
    std::lock_guard<std::mutex> lock(mutex_);
    pendingBytes_.erase(connectionId);
}

// ══════════════════════════════════════════════════════════════════════
//  ConnectionThrottler
// ══════════════════════════════════════════════════════════════════════

ConnectionThrottler::ConnectionThrottler(int maxConnectionsPerIP)
    : maxPerIP_(maxConnectionsPerIP) {}

bool ConnectionThrottler::allowConnection(const std::string& ip) {
    std::lock_guard<std::mutex> lock(mutex_);
    int count = ipCounts_[ip];
    if (count >= maxPerIP_) return false;
    ipCounts_[ip] = count + 1;
    return true;
}

void ConnectionThrottler::removeConnection(const std::string& ip) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = ipCounts_.find(ip);
    if (it != ipCounts_.end()) {
        if (--it->second <= 0) ipCounts_.erase(it);
    }
}

int ConnectionThrottler::getConnectionCount(const std::string& ip) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = ipCounts_.find(ip);
    return (it != ipCounts_.end()) ? it->second : 0;
}

// ══════════════════════════════════════════════════════════════════════
//  BroadcastHistory
// ══════════════════════════════════════════════════════════════════════

BroadcastHistory::BroadcastHistory(size_t maxEntriesPerRoom)
    : maxEntries_(maxEntriesPerRoom) {}

void BroadcastHistory::store(const std::string& room, const std::string& message,
                              const std::string& messageId) {
    std::lock_guard<std::mutex> lock(mutex_);
    HistoryEntry entry;
    entry.room = room;
    entry.message = message;
    entry.timestamp = nowMillis();
    entry.messageId = messageId;
    auto& vec = history_[room];
    vec.push_back(std::move(entry));
    if (vec.size() > maxEntries_) {
        size_t excess = vec.size() - maxEntries_;
        vec.erase(vec.begin(), vec.begin() + static_cast<std::ptrdiff_t>(excess));
    }
}

std::vector<HistoryEntry> BroadcastHistory::getSince(const std::string& room,
                                                      int64_t sinceTimestamp) const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<HistoryEntry> result;
    auto it = history_.find(room);
    if (it == history_.end()) return result;
    for (const auto& entry : it->second) {
        if (entry.timestamp > sinceTimestamp) result.push_back(entry);
    }
    return result;
}

HistoryEntry BroadcastHistory::getLast(const std::string& room) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = history_.find(room);
    if (it != history_.end() && !it->second.empty()) return it->second.back();
    return HistoryEntry{};
}

void BroadcastHistory::prune() {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [room, vec] : history_) {
        if (vec.size() > maxEntries_) {
            size_t excess = vec.size() - maxEntries_;
            vec.erase(vec.begin(), vec.begin() + static_cast<std::ptrdiff_t>(excess));
        }
    }
}

// ══════════════════════════════════════════════════════════════════════
//  ThreadSafeFunction helpers
//  NOTE: delete data AFTER cb.Call() — use-after-free if done before.
// ══════════════════════════════════════════════════════════════════════

namespace {

void callOpenTSFN(Napi::ThreadSafeFunction& tsfn, OpenData* d) {
    if (!tsfn) { delete d; return; }
    tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function cb, OpenData* data) {
        if (!env || !cb) { delete data; return; }
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("connectionId", Napi::String::New(env, data->connectionId));
        obj.Set("ip",           Napi::String::New(env, data->ip));
        obj.Set("userId",       Napi::String::New(env, data->userId));
        obj.Set("path",         Napi::String::New(env, data->path));
        cb.Call({obj});
        delete data; // FIX: delete AFTER use
    });
}

void callMessageTSFN(Napi::ThreadSafeFunction& tsfn, MessageData* d) {
    if (!tsfn) { delete d; return; }
    tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function cb, MessageData* data) {
        if (!env || !cb) { delete data; return; }
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("connectionId", Napi::String::New(env, data->connectionId));
        obj.Set("data",         Napi::String::New(env, data->message));
        obj.Set("bytes",        Napi::Number::New(env, static_cast<double>(data->bytes)));
        cb.Call({obj});
        delete data; // FIX: delete AFTER use
    });
}

void callCloseTSFN(Napi::ThreadSafeFunction& tsfn, CloseData* d) {
    if (!tsfn) { delete d; return; }
    tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function cb, CloseData* data) {
        if (!env || !cb) { delete data; return; }
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("connectionId", Napi::String::New(env, data->connectionId));
        obj.Set("code",         Napi::Number::New(env, data->code));
        obj.Set("reason",       Napi::String::New(env, data->reason));
        cb.Call({obj});
        delete data; // FIX: delete AFTER use
    });
}

void callDrainTSFN(Napi::ThreadSafeFunction& tsfn, DrainData* d) {
    if (!tsfn) { delete d; return; }
    tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function cb, DrainData* data) {
        if (!env || !cb) { delete data; return; }
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("connectionId", Napi::String::New(env, data->connectionId));
        cb.Call({obj});
        delete data; // FIX: delete AFTER use
    });
}

} // anonymous namespace

// ══════════════════════════════════════════════════════════════════════
//  WebSocketServer — N-API class definition
// ══════════════════════════════════════════════════════════════════════

Napi::Object WebSocketServer::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "WebSocketServer", {
        InstanceMethod("start",             &WebSocketServer::start),
        InstanceMethod("stop",              &WebSocketServer::stop),
        InstanceMethod("isRunning",         &WebSocketServer::isRunning),
        InstanceMethod("joinRoom",          &WebSocketServer::joinRoom),
        InstanceMethod("leaveRoom",         &WebSocketServer::leaveRoom),
        InstanceMethod("broadcastToRoom",   &WebSocketServer::broadcastToRoom),
        InstanceMethod("getRoomInfo",       &WebSocketServer::getRoomInfo),
        InstanceMethod("sendToConnection",  &WebSocketServer::sendToConnection),
        InstanceMethod("sendToUser",        &WebSocketServer::sendToUser),
        InstanceMethod("disconnect",        &WebSocketServer::disconnect),
        InstanceMethod("getConnectionCount",&WebSocketServer::getConnectionCount),
        InstanceMethod("getConnectionInfo", &WebSocketServer::getConnectionInfo),
        InstanceMethod("getMetrics",        &WebSocketServer::getMetrics),
        InstanceMethod("configure",         &WebSocketServer::configure),
        InstanceMethod("getHistory",        &WebSocketServer::getHistory),
    });

    Napi::FunctionReference* ctor = new Napi::FunctionReference();
    *ctor = Napi::Persistent(func);
    env.SetInstanceData(ctor);

    exports.Set("WebSocketServer", func);
    return exports;
}

// ── Constructor / Destructor ─────────────────────────────────────────

WebSocketServer::WebSocketServer(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WebSocketServer>(info)
    , port_(3000)
    , stopped_(false)   // explicit init (header has `= false`, but safe)
{

    if (info.Length() > 0 && info[0].IsObject()) {
        Napi::Object opts = info[0].As<Napi::Object>();
        if (opts.Has("host"))           host_               = opts.Get("host").As<Napi::String>().Utf8Value();
        if (opts.Has("port"))           port_               = opts.Get("port").As<Napi::Number>().Int32Value();
        if (opts.Has("idleTimeout"))    idleTimeoutSeconds_ = opts.Get("idleTimeout").As<Napi::Number>().Int32Value();
        if (opts.Has("maxPayloadBytes"))maxPayloadBytes_    = opts.Get("maxPayloadBytes").As<Napi::Number>().Int32Value();
        registerCallbacks(info);
    }

    // Initialize sub-components
    roomManager_         = std::make_unique<RoomManager>();
    rateLimiter_         = std::make_unique<RateLimiter>(120, maxPayloadBytes_);
    backpressureManager_ = std::make_unique<BackpressureManager>(highWaterMark_);
    connectionThrottler_ = std::make_unique<ConnectionThrottler>(10);
    broadcastHistory_    = std::make_unique<BroadcastHistory>(100);
}

// ── Destructor (guarded against concurrent stop()) ──────────────────

WebSocketServer::~WebSocketServer() {
    std::lock_guard<std::mutex> lock(stopMutex_);
    // Only perform shutdown/join if not already stopped and the server is running.
    if (!stopped_.exchange(true) && running_) {
        running_ = false;
        enqueueOp(OpType::SHUTDOWN, "", "");
        if (wsThread_.joinable()) wsThread_.join();
    }

    // Release TSFNs (safe even if stop() already released them)
    if (onOpenCallback_)    { onOpenCallback_.Release();    }
    if (onMessageCallback_) { onMessageCallback_.Release(); }
    if (onCloseCallback_)   { onCloseCallback_.Release();   }
    if (onDrainCallback_)   { onDrainCallback_.Release();   }
}

// ── Connection ID generation ─────────────────────────────────────────

std::string WebSocketServer::generateConnectionId() {
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    std::ostringstream oss;
    oss << std::hex << ms << "-" << randomHex(8);
    return oss.str();
}

// ── Callback registration ─────────────────────────────────────────────
//  FIX #3: Release existing TSFNs before overwriting them to avoid
//  leaking Node.js reference counts (which can prevent clean process exit).

void WebSocketServer::registerCallbacks(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() == 0 || !info[0].IsObject()) return;
    Napi::Object opts = info[0].As<Napi::Object>();

    auto makeTSFN = [&](const char* name) -> Napi::ThreadSafeFunction {
        if (!opts.Has(name) || !opts.Get(name).IsFunction()) return {};
        // Matches node-addon-api 8.9.0's New(env, fn, resourceName,
        // maxQueueSize, initialThreadCount) overload. The old 7-arg call
        // (nullptr context + finalizer) fails template deduction because
        // nullptr_t doesn't deduce against a ContextType* parameter — and
        // it isn't needed anyway since callOpenTSFN/etc. already delete
        // their own heap data after use.
        return Napi::ThreadSafeFunction::New(
            env, opts.Get(name).As<Napi::Function>(), name, 0, 1);
    };

    // Release old TSFNs before replacing — prevents Node.js refcount leaks
    if (onOpenCallback_)    { onOpenCallback_.Release();    }
    if (onMessageCallback_) { onMessageCallback_.Release(); }
    if (onCloseCallback_)   { onCloseCallback_.Release();   }
    if (onDrainCallback_)   { onDrainCallback_.Release();   }

    onOpenCallback_    = makeTSFN("onOpen");
    onMessageCallback_ = makeTSFN("onMessage");
    onCloseCallback_   = makeTSFN("onClose");
    onDrainCallback_   = makeTSFN("onDrain");
}

// ── Connection cleanup (called from uWS thread) ──────────────────────

void WebSocketServer::cleanupConnection(const std::string& connectionId) {
    // Remove from socket map
    {
        std::unique_lock<std::shared_mutex> lock(socketMutex_);
        sockets_.erase(connectionId);
    }

    // Leave all rooms (metadata)
    roomManager_->leaveAll(connectionId);

    // Reset rate limiter
    rateLimiter_->resetConnection(connectionId);

    // Remove backpressure tracking
    backpressureManager_->removeConnection(connectionId);

    // Remove user mapping, IP throttle, connection info
    {
        std::lock_guard<std::mutex> lock(userMapMutex_);
        auto connIt = connections_.find(connectionId);
        if (connIt != connections_.end()) {
            connectionThrottler_->removeConnection(connIt->second.ip);
            if (!connIt->second.userId.empty()) {
                auto userIt = userToConnection_.find(connIt->second.userId);
                if (userIt != userToConnection_.end() && userIt->second == connectionId)
                    userToConnection_.erase(userIt);
            }
            connections_.erase(connIt);
        }
    }

    metrics_.activeConnections.fetch_sub(1, std::memory_order_relaxed);
}

// ── Async operation queue (JS thread enqueues, uWS thread processes) ─

void WebSocketServer::enqueueOp(OpType type, const std::string& arg1, const std::string& arg2) {
    {
        std::lock_guard<std::mutex> lock(pendingMutex_);
        pendingOps_.push({type, arg1, arg2});
    }
    // async_ holds a uWS::Loop*. defer() is uWS's actual thread-safe
    // cross-thread wakeup call (no separate Async object in this version).
    if (async_) {
        static_cast<uWS::Loop*>(async_)->defer([this]() { executePendingOperations(); });
    }
}

void WebSocketServer::executePendingOperations() {
    // Drain the queue under lock, process without lock (all on uWS thread)
    std::queue<PendingOp> ops;
    {
        std::lock_guard<std::mutex> lock(pendingMutex_);
        ops.swap(pendingOps_);
    }

    // FIX #1: app_ stores a heap-allocated NativeApp*, cast accordingly.
    auto* app = static_cast<NativeApp*>(app_);
    if (!app) return;

    while (!ops.empty()) {
        PendingOp& op = ops.front();

        switch (op.type) {
        case OpType::SEND_TO_CONNECTION: {
            std::unique_lock<std::shared_mutex> lock(socketMutex_);
            auto it = sockets_.find(op.arg1);
            if (it != sockets_.end()) {
                auto* ws = static_cast<NativeWS*>(it->second);
                lock.unlock();
                size_t bytes = op.arg2.size();
                ws->send(op.arg2, uWS::OpCode::TEXT);
                metrics_.totalMessagesSent.fetch_add(1, std::memory_order_relaxed);
                metrics_.totalBytesSent.fetch_add(bytes, std::memory_order_relaxed);
                {
                    std::lock_guard<std::mutex> um(userMapMutex_);
                    auto ci = connections_.find(op.arg1);
                    if (ci != connections_.end()) {
                        ci->second.messagesSent++;
                        ci->second.bytesSent += bytes;
                        ci->second.lastSeen = std::chrono::steady_clock::now();
                    }
                }
            }
            break;
        }
        case OpType::BROADCAST_TO_ROOM: {
            std::string messageId = generateConnectionId();
            size_t bytes = op.arg2.size();

            // FIX #5 (minor): snapshot recipient count BEFORE publishing so
            // the metric isn't skewed by joins/leaves that race the publish.
            size_t recipients = roomManager_->getRoomSize(op.arg1);

            // publish()'s 3rd arg is the message OpCode (TEXT/BINARY), not a
            // compression flag — compression is the separate 4th bool arg.
            app->publish(op.arg1, op.arg2, uWS::OpCode::TEXT, compressionEnabled_);

            broadcastHistory_->store(op.arg1, op.arg2, messageId);

            metrics_.totalMessagesSent.fetch_add(recipients, std::memory_order_relaxed);
            metrics_.totalBytesSent.fetch_add(bytes * recipients, std::memory_order_relaxed);
            break;
        }
        case OpType::JOIN_ROOM: {
            {
                std::unique_lock<std::shared_mutex> lock(socketMutex_);
                auto it = sockets_.find(op.arg1);
                if (it != sockets_.end()) {
                    static_cast<NativeWS*>(it->second)->subscribe(op.arg2);
                }
            }
            roomManager_->join(op.arg1, op.arg2);
            {
                std::lock_guard<std::mutex> um(userMapMutex_);
                auto ci = connections_.find(op.arg1);
                if (ci != connections_.end()) {
                    ci->second.rooms.push_back(op.arg2);
                }
            }
            break;
        }
        case OpType::LEAVE_ROOM: {
            {
                std::unique_lock<std::shared_mutex> lock(socketMutex_);
                auto it = sockets_.find(op.arg1);
                if (it != sockets_.end()) {
                    static_cast<NativeWS*>(it->second)->unsubscribe(op.arg2);
                }
            }
            roomManager_->leave(op.arg1, op.arg2);
            {
                std::lock_guard<std::mutex> um(userMapMutex_);
                auto ci = connections_.find(op.arg1);
                if (ci != connections_.end()) {
                    auto& rooms = ci->second.rooms;
                    rooms.erase(std::remove(rooms.begin(), rooms.end(), op.arg2), rooms.end());
                }
            }
            break;
        }
        case OpType::DISCONNECT: {
            {
                std::unique_lock<std::shared_mutex> lock(socketMutex_);
                auto it = sockets_.find(op.arg1);
                if (it != sockets_.end()) {
                    auto* ws = static_cast<NativeWS*>(it->second);
                    lock.unlock();
                    ws->end(0, "");
                }
            }
            break;
        }
        case OpType::SHUTDOWN: {
            // uWS::Loop has no stop(). Per uWS's own docs: you never stop
            // the loop directly — you close the listen socket and end all
            // open sockets, and app->run() returns once the loop has
            // nothing left to do.
            if (listenSocket_) {
                us_listen_socket_close(0, static_cast<us_listen_socket_t*>(listenSocket_));
                listenSocket_ = nullptr;
            }
            {
                std::unique_lock<std::shared_mutex> lock(socketMutex_);
                for (auto& pair : sockets_) {
                    static_cast<NativeWS*>(pair.second)->end(0, "");
                }
                sockets_.clear();
            }
            break;
        }
        }

        ops.pop();
    }
}

// ══════════════════════════════════════════════════════════════════════
//  runServer — executed on the background thread
// ══════════════════════════════════════════════════════════════════════

void WebSocketServer::runServer() {
    // Capture config by value — this thread outlives the calling scope.
    auto host               = host_;
    auto port               = port_;
    auto compressionEnabled = compressionEnabled_;
    auto compressionLevel   = compressionLevel_;
    auto idleTimeout        = idleTimeoutSeconds_;
    auto maxPayload         = maxPayloadBytes_;
    auto hwm                = highWaterMark_;

    // FIX #1: Allocate uWS App on the heap so app_ doesn't become a
    // dangling pointer. The pointer is stored in app_ and deleted in the
    // post-loop cleanup block below.
    // NOTE: the App constructor takes SocketContextOptions, which has no
    // `compression` field — compression is a per-route setting and is
    // already set correctly below on app->ws<PerSocketData>(...).
    // Passing it here is what broke the constructor call.
    auto* app = new NativeApp();
    app_ = app;

    WebSocketServer* self = this;

    // ── Wakeup mechanism: drains the JS→uWS operation queue ──────────
    // uWS v20 has no uWS::Async class. The real thread-safe cross-thread
    // wakeup primitive is uWS::Loop::defer(), which runs a lambda on the
    // loop's own thread (it calls us_wakeup_loop internally). async_
    // stores the uWS::Loop* itself (still declared void* in the header)
    // so enqueueOp() can call defer() from the JS thread.
    async_ = uWS::Loop::get();
    // Signal start() that the loop pointer is ready
    loopReadyCv_.notify_all();

    // ── WebSocket handler ────────────────────────────────────────────
    // FIX #1: use -> not . because app is a pointer.
    app->ws<PerSocketData>("/*", {
        .compression      = compressionEnabled ? uWS::SHARED_COMPRESSOR : uWS::DISABLED,
        .maxPayloadLength = maxPayload,
        .idleTimeout      = static_cast<int32_t>(idleTimeout),
        .maxBackpressure  = static_cast<uint32_t>(hwm),

        .upgrade = [self](auto* res, auto* req, auto* context) {
            std::string ip   = extractIP(res, req);
            std::string path(req->getUrl());

            if (!self->connectionThrottler_->allowConnection(ip)) {
                self->metrics_.rejectedConnections.fetch_add(1, std::memory_order_relaxed);
                res->close();
                return;
            }

            std::string connId = self->generateConnectionId();

            res->template upgrade<PerSocketData>({
                .connectionId = connId,
                .ip           = ip,
                .userId       = "",
                .path         = path,
                .connectedAt  = std::chrono::steady_clock::now(),
                .lastSeen     = std::chrono::steady_clock::now(),
            },
            req->getHeader("sec-websocket-key"),
            req->getHeader("sec-websocket-protocol"),
            req->getHeader("sec-websocket-extensions"),
            // FIX: this 5th arg must be the us_socket_context_t* passed into
            // the upgrade handler (context) — not a header string. uWS uses
            // it to look up the WebSocket behavior/context to adopt into.
            context);
        },

        .open = [self](auto* ws) {
            auto* data = ws->getUserData();
            data->connectedAt = std::chrono::steady_clock::now();
            data->lastSeen    = data->connectedAt;

            {
                std::unique_lock<std::shared_mutex> lock(self->socketMutex_);
                self->sockets_[data->connectionId] = ws;
            }

            {
                std::lock_guard<std::mutex> lock(self->userMapMutex_);
                ConnectionInfo ci;
                ci.id          = data->connectionId;
                ci.ip          = data->ip;
                ci.userId      = data->userId;
                ci.connectedAt = data->connectedAt;
                ci.lastSeen    = data->connectedAt;
                self->connections_[data->connectionId] = std::move(ci);
            }

            self->metrics_.totalConnections.fetch_add(1, std::memory_order_relaxed);
            self->metrics_.activeConnections.fetch_add(1, std::memory_order_relaxed);

            auto* d = new OpenData{
                .connectionId = data->connectionId,
                .ip           = data->ip,
                .userId       = data->userId,
                .path         = data->path,
            };
            callOpenTSFN(self->onOpenCallback_, d);
        },

        .message = [self](auto* ws, std::string_view message, uWS::OpCode opCode) {
            auto* data = ws->getUserData();
            data->lastSeen = std::chrono::steady_clock::now();
            data->messagesReceived++;
            size_t bytes = message.size();

            self->metrics_.totalMessagesReceived.fetch_add(1, std::memory_order_relaxed);
            self->metrics_.totalBytesReceived.fetch_add(bytes, std::memory_order_relaxed);

            {
                std::lock_guard<std::mutex> lock(self->userMapMutex_);
                auto ci = self->connections_.find(data->connectionId);
                if (ci != self->connections_.end()) {
                    ci->second.messagesReceived++;
                    ci->second.bytesReceived += bytes;
                    ci->second.lastSeen = data->lastSeen;
                }
            }

            if (!self->rateLimiter_->checkRateLimit(data->connectionId)) {
                self->metrics_.droppedMessages.fetch_add(1, std::memory_order_relaxed);
                return;
            }
            if (!self->rateLimiter_->checkPayloadSize(bytes)) {
                self->metrics_.droppedMessages.fetch_add(1, std::memory_order_relaxed);
                return;
            }

            auto* d = new MessageData{
                .connectionId = data->connectionId,
                .message      = std::string(message),
                .bytes        = bytes,
            };
            callMessageTSFN(self->onMessageCallback_, d);

            (void)opCode;
        },

        .drain = [self](auto* ws) {
            auto* data = ws->getUserData();
            self->backpressureManager_->onDrain(data->connectionId);

            auto* d = new DrainData{.connectionId = data->connectionId};
            callDrainTSFN(self->onDrainCallback_, d);
        },

        .close = [self](auto* ws, int code, std::string_view message) {
            auto* data = ws->getUserData();
            std::string connId = data->connectionId;

            // Notify JS before cleanup destroys the per-connection data
            auto* d = new CloseData{
                .connectionId = connId,
                .code         = code,
                .reason       = std::string(message),
            };
            callCloseTSFN(self->onCloseCallback_, d);

            self->cleanupConnection(connId);
        },
    });

    // FIX #1: use -> not .
    app->listen(host, port, [self](auto* listenSocket) {
        if (!listenSocket) {
            fprintf(stderr, "[elysiajscppws] FATAL: failed to bind to port\n");
        } else {
            // Stored so SHUTDOWN can close it later — see note above SHUTDOWN
            // handling in executePendingOperations().
            self->listenSocket_ = listenSocket;
        }
    });

    // Blocks until the loop falls through naturally — i.e. until SHUTDOWN
    // closes the listen socket and ends all open connections.
    app->run();

    // ── Post-loop cleanup ────────────────────────────────────────────
    // async_ just holds a uWS::Loop*, which uWS owns — never delete it.
    async_ = nullptr;
    // FIX #1: delete the heap-allocated NativeApp (was stack-local before)
    delete static_cast<NativeApp*>(app_);
    app_ = nullptr;
}

// ══════════════════════════════════════════════════════════════════════
//  N-API methods — called from the JS thread
// ══════════════════════════════════════════════════════════════════════

// ── Lifecycle ────────────────────────────────────────────────────────

Napi::Value WebSocketServer::start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (running_) {
        Napi::Error::New(env, "WebSocket server is already running").ThrowAsJavaScriptException();
        return env.Null();
    }
    running_ = true;
    metrics_.startedAt = std::chrono::steady_clock::now();
    wsThread_ = std::thread(&WebSocketServer::runServer, this);

    // Wait until runServer() has set async_ (the uWS loop pointer) before
    // returning. Without this, stop() called immediately after start() finds
    // async_ == nullptr and skips the defer() wakeup, so SHUTDOWN never runs
    // and wsThread_.join() blocks forever.
    std::unique_lock<std::mutex> lk(loopReadyMutex_);
    loopReadyCv_.wait(lk, [this] { return async_ != nullptr || !running_; });

    return Napi::Boolean::New(env, true);
}

// ── stop() — now guarded against concurrent calls ────────────────────

Napi::Value WebSocketServer::stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    std::lock_guard<std::mutex> lock(stopMutex_);
    // If already stopped (or stopping), return false.
    if (stopped_.exchange(true)) return Napi::Boolean::New(env, false);

    running_ = false;
    enqueueOp(OpType::SHUTDOWN, "", "");
    if (wsThread_.joinable()) wsThread_.join();

    // Release TSFNs (safe even if destructor later tries again)
    if (onOpenCallback_)    { onOpenCallback_.Release();    onOpenCallback_    = Napi::ThreadSafeFunction(); }
    if (onMessageCallback_) { onMessageCallback_.Release(); onMessageCallback_ = Napi::ThreadSafeFunction(); }
    if (onCloseCallback_)   { onCloseCallback_.Release();   onCloseCallback_   = Napi::ThreadSafeFunction(); }
    if (onDrainCallback_)   { onDrainCallback_.Release();   onDrainCallback_   = Napi::ThreadSafeFunction(); }

    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::isRunning(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), running_.load());
}

// ── Room operations (dispatched to uWS thread via async queue) ───────

Napi::Value WebSocketServer::joinRoom(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "joinRoom(connectionId: string, room: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    enqueueOp(OpType::JOIN_ROOM,
              info[0].As<Napi::String>().Utf8Value(),
              info[1].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::leaveRoom(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "leaveRoom(connectionId: string, room: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    enqueueOp(OpType::LEAVE_ROOM,
              info[0].As<Napi::String>().Utf8Value(),
              info[1].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::broadcastToRoom(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "broadcastToRoom(room: string, message: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    enqueueOp(OpType::BROADCAST_TO_ROOM,
              info[0].As<Napi::String>().Utf8Value(),
              info[1].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::getRoomInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "getRoomInfo(room: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string room = info[0].As<Napi::String>().Utf8Value();

    Napi::Object result = Napi::Object::New(env);
    result.Set("name", Napi::String::New(env, room));
    result.Set("size", Napi::Number::New(env, static_cast<double>(roomManager_->getRoomSize(room))));

    auto conns = roomManager_->getConnectionsInRoom(room);
    Napi::Array arr = Napi::Array::New(env, conns.size());
    for (size_t i = 0; i < conns.size(); ++i)
        arr.Set(i, Napi::String::New(env, conns[i]));
    result.Set("connections", arr);
    return result;
}

// ── Direct messaging ─────────────────────────────────────────────────

Napi::Value WebSocketServer::sendToConnection(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "sendToConnection(connectionId: string, message: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    enqueueOp(OpType::SEND_TO_CONNECTION,
              info[0].As<Napi::String>().Utf8Value(),
              info[1].As<Napi::String>().Utf8Value());
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::sendToUser(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "sendToUser(userId: string, message: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string userId  = info[0].As<Napi::String>().Utf8Value();
    std::string message = info[1].As<Napi::String>().Utf8Value();

    std::string connId;
    {
        std::lock_guard<std::mutex> lock(userMapMutex_);
        auto it = userToConnection_.find(userId);
        if (it != userToConnection_.end()) connId = it->second;
    }
    if (connId.empty()) return Napi::Boolean::New(env, false);

    enqueueOp(OpType::SEND_TO_CONNECTION, connId, message);
    return Napi::Boolean::New(env, true);
}

// ── Connection management ────────────────────────────────────────────

Napi::Value WebSocketServer::disconnect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "disconnect(connectionId: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    enqueueOp(OpType::DISCONNECT, info[0].As<Napi::String>().Utf8Value(), "");
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::getConnectionCount(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(),
        static_cast<double>(metrics_.activeConnections.load(std::memory_order_relaxed)));
}

Napi::Value WebSocketServer::getConnectionInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "getConnectionInfo(connectionId: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string connId = info[0].As<Napi::String>().Utf8Value();

    ConnectionInfo ci;
    bool found = false;
    {
        std::lock_guard<std::mutex> lock(userMapMutex_);
        auto it = connections_.find(connId);
        if (it != connections_.end()) { ci = it->second; found = true; }
    }
    if (!found) return env.Null();

    Napi::Object result = Napi::Object::New(env);
    result.Set("id",     Napi::String::New(env, ci.id));
    result.Set("ip",     Napi::String::New(env, ci.ip));
    result.Set("userId", Napi::String::New(env, ci.userId));

    Napi::Array rooms = Napi::Array::New(env, ci.rooms.size());
    for (size_t i = 0; i < ci.rooms.size(); ++i)
        rooms.Set(i, Napi::String::New(env, ci.rooms[i]));
    result.Set("rooms", rooms);

    auto connMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        ci.connectedAt.time_since_epoch()).count();
    auto seenMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        ci.lastSeen.time_since_epoch()).count();

    result.Set("connectedAt",       Napi::Number::New(env, static_cast<double>(connMs)));
    result.Set("lastSeen",          Napi::Number::New(env, static_cast<double>(seenMs)));
    result.Set("messagesReceived",  Napi::Number::New(env, static_cast<double>(ci.messagesReceived)));
    result.Set("messagesSent",      Napi::Number::New(env, static_cast<double>(ci.messagesSent)));
    result.Set("bytesReceived",     Napi::Number::New(env, static_cast<double>(ci.bytesReceived)));
    result.Set("bytesSent",         Napi::Number::New(env, static_cast<double>(ci.bytesSent)));
    return result;
}

// ── Metrics ───────────────────────────────────────────────────────────

Napi::Value WebSocketServer::getMetrics(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object r = Napi::Object::New(env);
    r.Set("totalConnections",      Napi::Number::New(env, static_cast<double>(metrics_.totalConnections.load(std::memory_order_relaxed))));
    r.Set("activeConnections",     Napi::Number::New(env, static_cast<double>(metrics_.activeConnections.load(std::memory_order_relaxed))));
    r.Set("totalMessagesReceived", Napi::Number::New(env, static_cast<double>(metrics_.totalMessagesReceived.load(std::memory_order_relaxed))));
    r.Set("totalMessagesSent",     Napi::Number::New(env, static_cast<double>(metrics_.totalMessagesSent.load(std::memory_order_relaxed))));
    r.Set("totalBytesReceived",    Napi::Number::New(env, static_cast<double>(metrics_.totalBytesReceived.load(std::memory_order_relaxed))));
    r.Set("totalBytesSent",        Napi::Number::New(env, static_cast<double>(metrics_.totalBytesSent.load(std::memory_order_relaxed))));
    r.Set("droppedMessages",       Napi::Number::New(env, static_cast<double>(metrics_.droppedMessages.load(std::memory_order_relaxed))));
    r.Set("rejectedConnections",   Napi::Number::New(env, static_cast<double>(metrics_.rejectedConnections.load(std::memory_order_relaxed))));

    auto startedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        metrics_.startedAt.time_since_epoch()).count();
    r.Set("uptimeMs", Napi::Number::New(env, static_cast<double>(nowMillis() - startedMs)));
    return r;
}

// ── Configuration (must be called before start) ──────────────────────

Napi::Value WebSocketServer::configure(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "configure requires an options object").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Object opts = info[0].As<Napi::Object>();

    if (opts.Has("host"))            host_               = opts.Get("host").As<Napi::String>().Utf8Value();
    if (opts.Has("port"))            port_               = opts.Get("port").As<Napi::Number>().Int32Value();
    if (opts.Has("idleTimeout"))     idleTimeoutSeconds_ = opts.Get("idleTimeout").As<Napi::Number>().Int32Value();
    if (opts.Has("maxPayloadBytes")) maxPayloadBytes_    = opts.Get("maxPayloadBytes").As<Napi::Number>().Int32Value();

    if (opts.Has("compression")) {
        Napi::Value cv = opts.Get("compression");
        if (cv.IsBoolean()) compressionEnabled_ = cv.As<Napi::Boolean>().Value();
        else if (cv.IsObject()) {
            compressionEnabled_ = true;
            Napi::Object co = cv.As<Napi::Object>();
            if (co.Has("level")) compressionLevel_ = co.Get("level").As<Napi::Number>().Int32Value();
        }
    }

    if (opts.Has("highWaterMarkBytes")) {
        highWaterMark_ = static_cast<size_t>(opts.Get("highWaterMarkBytes").As<Napi::Number>().Int64Value());
        backpressureManager_ = std::make_unique<BackpressureManager>(highWaterMark_);
    }
    if (opts.Has("maxConnectionsPerIP"))
        connectionThrottler_ = std::make_unique<ConnectionThrottler>(
            opts.Get("maxConnectionsPerIP").As<Napi::Number>().Int32Value());
    if (opts.Has("maxMessagesPerMinute"))
        rateLimiter_ = std::make_unique<RateLimiter>(
            opts.Get("maxMessagesPerMinute").As<Napi::Number>().Int32Value(), maxPayloadBytes_);
    if (opts.Has("maxHistoryPerRoom"))
        broadcastHistory_ = std::make_unique<BroadcastHistory>(
            static_cast<size_t>(opts.Get("maxHistoryPerRoom").As<Napi::Number>().Int32Value()));

    // FIX #3: Only update TSFNs when callbacks are explicitly provided.
    // registerCallbacks releases old TSFNs before creating new ones.
    if (opts.Has("onOpen") || opts.Has("onMessage") ||
        opts.Has("onClose") || opts.Has("onDrain")) {
        registerCallbacks(info);
    }

    Napi::Object r = Napi::Object::New(env);
    r.Set("host",               Napi::String::New(env, host_));
    r.Set("port",               Napi::Number::New(env, port_));
    r.Set("compressionEnabled", Napi::Boolean::New(env, compressionEnabled_));
    r.Set("compressionLevel",   Napi::Number::New(env, compressionLevel_));
    r.Set("idleTimeoutSeconds", Napi::Number::New(env, idleTimeoutSeconds_));
    r.Set("maxPayloadBytes",    Napi::Number::New(env, maxPayloadBytes_));
    return r;
}

// ── History ───────────────────────────────────────────────────────────

Napi::Value WebSocketServer::getHistory(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "getHistory(room: string [, sinceTimestamp: number])")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string room = info[0].As<Napi::String>().Utf8Value();
    int64_t since = 0;
    if (info.Length() >= 2 && info[1].IsNumber())
        since = info[1].As<Napi::Number>().Int64Value();

    auto entries = broadcastHistory_->getSince(room, since);
    Napi::Array arr = Napi::Array::New(env, entries.size());
    for (size_t i = 0; i < entries.size(); ++i) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("room",      Napi::String::New(env, entries[i].room));
        obj.Set("message",   Napi::String::New(env, entries[i].message));
        obj.Set("timestamp", Napi::Number::New(env, static_cast<double>(entries[i].timestamp)));
        obj.Set("messageId", Napi::String::New(env, entries[i].messageId));
        arr.Set(i, obj);
    }
    return arr;
}

} // namespace elysiacppws
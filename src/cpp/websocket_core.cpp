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
#include <chrono>
#include <ctime>

// ── LOGGING MACRO ─────────────────────────────────────────────────────
#define LOG(fmt, ...) do { \
    auto now = std::chrono::system_clock::now(); \
    auto now_c = std::chrono::system_clock::to_time_t(now); \
    std::tm now_tm = *std::localtime(&now_c); \
    fprintf(stderr, "[WS][%02d:%02d:%02d.%03d][%s:%d] " fmt "\n", \
        now_tm.tm_hour, now_tm.tm_min, now_tm.tm_sec, \
        (int)(std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000), \
        __func__, __LINE__, ##__VA_ARGS__); \
} while(0)

namespace elysiacppws {

// Convenience alias — matches the template params in the header forward-decl.
using NativeWS = uWS::WebSocket<false, true, PerSocketData>;
using NativeApp = uWS::App;

// ══════════════════════════════════════════════════════════════════════
//  Utility
// ══════════════════════════════════════════════════════════════════════

namespace {

std::string randomHex(size_t numBytes) {
    LOG("numBytes=%zu", numBytes);
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
    LOG("generated hex: %s", result.c_str());
    return result;
}

int64_t nowMillis() {
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    LOG("nowMillis=%lld", (long long)ms);
    return ms;
}

// FIX #4: Robust IP extraction that handles IPv4, IPv4-mapped IPv6,
// bracketed IPv6 (e.g. [::1]:port), and bare IPv6 addresses correctly.
std::string extractIP(auto* res, auto* req) {
    LOG("extracting IP");
    // Prefer explicit forwarding headers
    std::string_view xff = req->getHeader("x-forwarded-for");
    if (!xff.empty()) {
        auto comma = xff.find(',');
        // Trim leading whitespace from first entry
        std::string_view first = xff.substr(0, comma != std::string_view::npos ? comma : xff.size());
        size_t start = first.find_first_not_of(' ');
        std::string ip = std::string(start != std::string_view::npos ? first.substr(start) : first);
        LOG("extracted IP from x-forwarded-for: %s", ip.c_str());
        return ip;
    }

    std::string_view realIP = req->getHeader("x-real-ip");
    if (!realIP.empty()) {
        LOG("extracted IP from x-real-ip: %s", std::string(realIP).c_str());
        return std::string(realIP);
    }

    // FIX: getRemoteAddress()/getRemoteAddressAsText() live on HttpResponse,
    // not HttpRequest — uWS exposes them on the response/socket object.
    // ...AsText() already returns plain text with no port suffix, so the
    // bracket/colon parsing below is just defensive for any other source.
    std::string_view addr = res->getRemoteAddressAsText();
    if (addr.empty()) {
        LOG("remote address empty, returning unknown");
        return "unknown";
    }

    // Bracketed IPv6: [::1]:port
    if (addr.front() == '[') {
        auto close = addr.find(']');
        if (close != std::string_view::npos) {
            std::string ip = std::string(addr.substr(1, close - 1));
            LOG("extracted bracketed IPv6: %s", ip.c_str());
            return ip;
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
            std::string ip = std::string(addr.substr(0, colon));
            LOG("extracted IPv4: %s", ip.c_str());
            return ip;
        }
    }

    // Bare IPv6 or anything else — return as-is
    LOG("returning raw address: %s", std::string(addr).c_str());
    return std::string(addr);
}

} // anonymous namespace

// ══════════════════════════════════════════════════════════════════════
//  RateLimiter
// ══════════════════════════════════════════════════════════════════════

RateLimiter::RateLimiter(int maxMessagesPerMinute, int maxPayloadBytes)
    : maxPerMinute_(maxMessagesPerMinute)
    , maxPayloadBytes_(maxPayloadBytes) {
    LOG("maxMessagesPerMinute=%d, maxPayloadBytes=%d", maxMessagesPerMinute, maxPayloadBytes);
}

bool RateLimiter::checkRateLimit(const std::string& connectionId) {
    LOG("connectionId=%s", connectionId.c_str());
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
        LOG("rate limit exceeded for %s, dropped count=%d", connectionId.c_str(), droppedCounts_[connectionId]);
        return false;
    }
    sw.timestamps.push_back(now);
    LOG("rate limit ok for %s, window size=%zu", connectionId.c_str(), sw.timestamps.size());
    return true;
}

bool RateLimiter::checkPayloadSize(size_t payloadSize) {
    bool ok = static_cast<int>(payloadSize) <= maxPayloadBytes_;
    LOG("payloadSize=%zu, max=%d, ok=%d", payloadSize, maxPayloadBytes_, ok);
    return ok;
}

void RateLimiter::resetConnection(const std::string& connectionId) {
    LOG("connectionId=%s", connectionId.c_str());
    std::lock_guard<std::mutex> lock(mutex_);
    windows_.erase(connectionId);
    droppedCounts_.erase(connectionId);
}

int RateLimiter::getDroppedCount(const std::string& connectionId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = droppedCounts_.find(connectionId);
    int count = (it != droppedCounts_.end()) ? it->second : 0;
    LOG("connectionId=%s, dropped=%d", connectionId.c_str(), count);
    return count;
}

// ══════════════════════════════════════════════════════════════════════
//  RoomManager  (metadata only; uWS topics handle actual routing)
// ══════════════════════════════════════════════════════════════════════

void RoomManager::join(const std::string& connectionId, const std::string& room) {
    LOG("connectionId=%s, room=%s", connectionId.c_str(), room.c_str());
    std::lock_guard<std::mutex> lock(mutex_);
    roomMembers_[room].insert(connectionId);
    connectionRooms_[connectionId].insert(room);
    LOG("room %s now has %zu members, connection %s has %zu rooms",
        room.c_str(), roomMembers_[room].size(),
        connectionId.c_str(), connectionRooms_[connectionId].size());
}

void RoomManager::leave(const std::string& connectionId, const std::string& room) {
    LOG("connectionId=%s, room=%s", connectionId.c_str(), room.c_str());
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
    LOG("connectionId=%s", connectionId.c_str());
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
    LOG("connection %s left all %zu rooms", connectionId.c_str(), rooms.size());
}

void RoomManager::broadcast(const std::string& /*room*/, const std::string& /*message*/) {
    LOG("stub called (no-op)");
}

std::vector<std::string> RoomManager::getRooms(const std::string& connectionId) const {
    LOG("connectionId=%s", connectionId.c_str());
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = connectionRooms_.find(connectionId);
    if (it != connectionRooms_.end()) {
        std::vector<std::string> rooms(it->second.begin(), it->second.end());
        LOG("found %zu rooms", rooms.size());
        return rooms;
    }
    LOG("no rooms");
    return {};
}

std::vector<std::string> RoomManager::getConnectionsInRoom(const std::string& room) const {
    LOG("room=%s", room.c_str());
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = roomMembers_.find(room);
    if (it != roomMembers_.end()) {
        std::vector<std::string> conns(it->second.begin(), it->second.end());
        LOG("room %s has %zu connections", room.c_str(), conns.size());
        return conns;
    }
    LOG("room %s not found", room.c_str());
    return {};
}

size_t RoomManager::getRoomSize(const std::string& room) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = roomMembers_.find(room);
    size_t size = (it != roomMembers_.end()) ? it->second.size() : 0;
    LOG("room=%s, size=%zu", room.c_str(), size);
    return size;
}

size_t RoomManager::getTotalRooms() const {
    std::lock_guard<std::mutex> lock(mutex_);
    size_t total = roomMembers_.size();
    LOG("total rooms=%zu", total);
    return total;
}

// ══════════════════════════════════════════════════════════════════════
//  BackpressureManager
// ══════════════════════════════════════════════════════════════════════

BackpressureManager::BackpressureManager(size_t highWaterMark)
    : highWaterMark_(highWaterMark) {
    LOG("highWaterMark=%zu", highWaterMark);
}

bool BackpressureManager::canWrite(const std::string& connectionId, size_t pendingBytes) {
    std::lock_guard<std::mutex> lock(mutex_);
    size_t current = pendingBytes_[connectionId];
    bool ok = (current + pendingBytes <= highWaterMark_);
    LOG("connectionId=%s, current=%zu, pending=%zu, highWaterMark=%zu, ok=%d",
        connectionId.c_str(), current, pendingBytes, highWaterMark_, ok);
    if (ok) pendingBytes_[connectionId] = current + pendingBytes;
    return ok;
}

void BackpressureManager::onDrain(const std::string& connectionId) {
    std::lock_guard<std::mutex> lock(mutex_);
    pendingBytes_[connectionId] = 0;
    LOG("connectionId=%s drained", connectionId.c_str());
}

size_t BackpressureManager::getPendingBytes(const std::string& connectionId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = pendingBytes_.find(connectionId);
    size_t bytes = (it != pendingBytes_.end()) ? it->second : 0;
    LOG("connectionId=%s, pending=%zu", connectionId.c_str(), bytes);
    return bytes;
}

void BackpressureManager::removeConnection(const std::string& connectionId) {
    std::lock_guard<std::mutex> lock(mutex_);
    pendingBytes_.erase(connectionId);
    LOG("connectionId=%s removed", connectionId.c_str());
}

// ══════════════════════════════════════════════════════════════════════
//  ConnectionThrottler
// ══════════════════════════════════════════════════════════════════════

ConnectionThrottler::ConnectionThrottler(int maxConnectionsPerIP)
    : maxPerIP_(maxConnectionsPerIP) {
    LOG("maxConnectionsPerIP=%d", maxConnectionsPerIP);
}

bool ConnectionThrottler::allowConnection(const std::string& ip) {
    std::lock_guard<std::mutex> lock(mutex_);
    int count = ipCounts_[ip];
    bool ok = (count < maxPerIP_);
    LOG("ip=%s, current=%d, max=%d, ok=%d", ip.c_str(), count, maxPerIP_, ok);
    if (ok) ipCounts_[ip] = count + 1;
    return ok;
}

void ConnectionThrottler::removeConnection(const std::string& ip) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = ipCounts_.find(ip);
    if (it != ipCounts_.end()) {
        if (--it->second <= 0) ipCounts_.erase(it);
        LOG("ip=%s removed, new count=%d", ip.c_str(), it->second);
    } else {
        LOG("ip=%s not found", ip.c_str());
    }
}

int ConnectionThrottler::getConnectionCount(const std::string& ip) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = ipCounts_.find(ip);
    int count = (it != ipCounts_.end()) ? it->second : 0;
    LOG("ip=%s, count=%d", ip.c_str(), count);
    return count;
}

// ══════════════════════════════════════════════════════════════════════
//  BroadcastHistory
// ══════════════════════════════════════════════════════════════════════

BroadcastHistory::BroadcastHistory(size_t maxEntriesPerRoom)
    : maxEntries_(maxEntriesPerRoom) {
    LOG("maxEntriesPerRoom=%zu", maxEntriesPerRoom);
}

void BroadcastHistory::store(const std::string& room, const std::string& message,
                              const std::string& messageId) {
    LOG("room=%s, messageLen=%zu, messageId=%s", room.c_str(), message.size(), messageId.c_str());
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
        LOG("pruned %zu entries from room %s", excess, room.c_str());
    }
    LOG("room %s now has %zu entries", room.c_str(), vec.size());
}

std::vector<HistoryEntry> BroadcastHistory::getSince(const std::string& room,
                                                      int64_t sinceTimestamp) const {
    LOG("room=%s, since=%lld", room.c_str(), (long long)sinceTimestamp);
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<HistoryEntry> result;
    auto it = history_.find(room);
    if (it == history_.end()) {
        LOG("room %s not found", room.c_str());
        return result;
    }
    for (const auto& entry : it->second) {
        if (entry.timestamp > sinceTimestamp) result.push_back(entry);
    }
    LOG("found %zu entries", result.size());
    return result;
}

HistoryEntry BroadcastHistory::getLast(const std::string& room) const {
    LOG("room=%s", room.c_str());
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = history_.find(room);
    if (it != history_.end() && !it->second.empty()) {
        LOG("last entry timestamp=%lld", (long long)it->second.back().timestamp);
        return it->second.back();
    }
    LOG("no entries");
    return HistoryEntry{};
}

void BroadcastHistory::prune() {
    LOG("prune called");
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [room, vec] : history_) {
        if (vec.size() > maxEntries_) {
            size_t excess = vec.size() - maxEntries_;
            vec.erase(vec.begin(), vec.begin() + static_cast<std::ptrdiff_t>(excess));
            LOG("pruned %zu entries from room %s", excess, room.c_str());
        }
    }
}

// ══════════════════════════════════════════════════════════════════════
//  ThreadSafeFunction helpers
//  NOTE: delete data AFTER cb.Call() — use-after-free if done before.
// ══════════════════════════════════════════════════════════════════════

namespace {

void callOpenTSFN(Napi::ThreadSafeFunction& tsfn, OpenData* d) {
    LOG("tsfn valid=%d, connectionId=%s", (bool)tsfn, d ? d->connectionId.c_str() : "null");
    if (!tsfn) { delete d; LOG("tsfn invalid, deleted data"); return; }
    tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function cb, OpenData* data) {
        LOG("open callback invoked in JS thread, connectionId=%s", data->connectionId.c_str());
        if (!env || !cb) { delete data; LOG("env or cb invalid, deleted data"); return; }
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("connectionId", Napi::String::New(env, data->connectionId));
        obj.Set("ip",           Napi::String::New(env, data->ip));
        obj.Set("userId",       Napi::String::New(env, data->userId));
        obj.Set("path",         Napi::String::New(env, data->path));
        cb.Call({obj});
        delete data;
        LOG("open callback completed");
    });
}

void callMessageTSFN(Napi::ThreadSafeFunction& tsfn, MessageData* d) {
    LOG("tsfn valid=%d, connectionId=%s, messageLen=%zu", (bool)tsfn, d ? d->connectionId.c_str() : "null", d ? d->message.size() : 0);
    if (!tsfn) { delete d; LOG("tsfn invalid, deleted data"); return; }
    tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function cb, MessageData* data) {
        LOG("message callback invoked in JS thread, connectionId=%s", data->connectionId.c_str());
        if (!env || !cb) { delete data; LOG("env or cb invalid, deleted data"); return; }
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("connectionId", Napi::String::New(env, data->connectionId));
        obj.Set("data",         Napi::String::New(env, data->message));
        obj.Set("bytes",        Napi::Number::New(env, static_cast<double>(data->bytes)));
        cb.Call({obj});
        delete data;
        LOG("message callback completed");
    });
}

void callCloseTSFN(Napi::ThreadSafeFunction& tsfn, CloseData* d) {
    LOG("tsfn valid=%d, connectionId=%s, code=%d", (bool)tsfn, d ? d->connectionId.c_str() : "null", d ? d->code : -1);
    if (!tsfn) { delete d; LOG("tsfn invalid, deleted data"); return; }
    tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function cb, CloseData* data) {
        LOG("close callback invoked in JS thread, connectionId=%s", data->connectionId.c_str());
        if (!env || !cb) { delete data; LOG("env or cb invalid, deleted data"); return; }
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("connectionId", Napi::String::New(env, data->connectionId));
        obj.Set("code",         Napi::Number::New(env, data->code));
        obj.Set("reason",       Napi::String::New(env, data->reason));
        cb.Call({obj});
        delete data;
        LOG("close callback completed");
    });
}

void callDrainTSFN(Napi::ThreadSafeFunction& tsfn, DrainData* d) {
    LOG("tsfn valid=%d, connectionId=%s", (bool)tsfn, d ? d->connectionId.c_str() : "null");
    if (!tsfn) { delete d; LOG("tsfn invalid, deleted data"); return; }
    tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function cb, DrainData* data) {
        LOG("drain callback invoked in JS thread, connectionId=%s", data->connectionId.c_str());
        if (!env || !cb) { delete data; LOG("env or cb invalid, deleted data"); return; }
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("connectionId", Napi::String::New(env, data->connectionId));
        cb.Call({obj});
        delete data;
        LOG("drain callback completed");
    });
}

} // anonymous namespace

// ══════════════════════════════════════════════════════════════════════
//  WebSocketServer — N-API class definition
// ══════════════════════════════════════════════════════════════════════

Napi::Object WebSocketServer::Init(Napi::Env env, Napi::Object exports) {
    LOG("entered");
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
    LOG("Init complete");
    return exports;
}

// ── Constructor / Destructor ─────────────────────────────────────────

WebSocketServer::WebSocketServer(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WebSocketServer>(info)
    , port_(3000)
    , stopped_(false)
{
    LOG("constructor called");
    if (info.Length() > 0 && info[0].IsObject()) {
        Napi::Object opts = info[0].As<Napi::Object>();
        if (opts.Has("host"))           host_               = opts.Get("host").As<Napi::String>().Utf8Value();
        if (opts.Has("port"))           port_               = opts.Get("port").As<Napi::Number>().Int32Value();
        if (opts.Has("idleTimeout"))    idleTimeoutSeconds_ = opts.Get("idleTimeout").As<Napi::Number>().Int32Value();
        if (opts.Has("maxPayloadBytes"))maxPayloadBytes_    = opts.Get("maxPayloadBytes").As<Napi::Number>().Int32Value();
        LOG("options parsed: host=%s, port=%d, idleTimeout=%d, maxPayload=%d",
            host_.c_str(), port_, idleTimeoutSeconds_, maxPayloadBytes_);
        registerCallbacks(info);
    }

    // Initialize sub-components
    roomManager_         = std::make_unique<RoomManager>();
    rateLimiter_         = std::make_unique<RateLimiter>(120, maxPayloadBytes_);
    backpressureManager_ = std::make_unique<BackpressureManager>(highWaterMark_);
    connectionThrottler_ = std::make_unique<ConnectionThrottler>(10);
    broadcastHistory_    = std::make_unique<BroadcastHistory>(100);
    LOG("constructor complete");
}

// ── Destructor (guarded against concurrent stop()) ──────────────────

WebSocketServer::~WebSocketServer() {
    LOG("destructor called");
    std::lock_guard<std::mutex> lock(stopMutex_);
    if (!stopped_.exchange(true) && running_) {
        LOG("stopping running server in destructor");
        running_ = false;
        enqueueOp(OpType::SHUTDOWN, "", "");
        if (wsThread_.joinable()) wsThread_.join();
    }

    // Release TSFNs (safe even if stop() already released them)
    if (onOpenCallback_)          { onOpenCallback_.Release();          LOG("released onOpenCallback_"); }
    if (onMessageCallback_)       { onMessageCallback_.Release();       LOG("released onMessageCallback_"); }
    if (onCloseCallback_)         { onCloseCallback_.Release();         LOG("released onCloseCallback_"); }
    if (onDrainCallback_)         { onDrainCallback_.Release();         LOG("released onDrainCallback_"); }
    LOG("destructor complete");
}

// ── Connection ID generation ─────────────────────────────────────────

std::string WebSocketServer::generateConnectionId() {
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    std::ostringstream oss;
    oss << std::hex << ms << "-" << randomHex(8);
    std::string id = oss.str();
    LOG("generated connectionId=%s", id.c_str());
    return id;
}

// ── Callback registration ─────────────────────────────────────────────
//  FIX #3: Release existing TSFNs before overwriting them to avoid
//  leaking Node.js reference counts (which can prevent clean process exit).

void WebSocketServer::registerCallbacks(const Napi::CallbackInfo& info) {
    LOG("registerCallbacks called");
    Napi::Env env = info.Env();

    if (running_) {
        LOG("registerCallbacks rejected — server is running");
        Napi::Error::New(env, "Cannot reconfigure callbacks while server is running")
            .ThrowAsJavaScriptException();
        return;
    }

    if (info.Length() == 0 || !info[0].IsObject()) {
        LOG("no options object, returning");
        return;
    }
    Napi::Object opts = info[0].As<Napi::Object>();

    auto makeTSFN = [&](const char* name) -> Napi::ThreadSafeFunction {
        if (!opts.Has(name) || !opts.Get(name).IsFunction()) {
            LOG("callback %s not provided", name);
            return {};
        }
        LOG("creating TSFN for %s", name);
        return Napi::ThreadSafeFunction::New(
            env, opts.Get(name).As<Napi::Function>(), name, 0, 1);
    };

    // Release old TSFNs before replacing
    if (onOpenCallback_)          { onOpenCallback_.Release();          LOG("released old onOpenCallback_"); }
    if (onMessageCallback_)       { onMessageCallback_.Release();       LOG("released old onMessageCallback_"); }
    if (onCloseCallback_)         { onCloseCallback_.Release();         LOG("released old onCloseCallback_"); }
    if (onDrainCallback_)         { onDrainCallback_.Release();         LOG("released old onDrainCallback_"); }

    onOpenCallback_    = makeTSFN("onOpen");
    onMessageCallback_ = makeTSFN("onMessage");
    onCloseCallback_   = makeTSFN("onClose");
    onDrainCallback_   = makeTSFN("onDrain");
    LOG("registerCallbacks complete");
}

// ── Connection cleanup (called from uWS thread) ──────────────────────

void WebSocketServer::cleanupConnection(const std::string& connectionId) {
    LOG("connectionId=%s", connectionId.c_str());
    {
        std::unique_lock<std::shared_mutex> lock(socketMutex_);
        auto erased = sockets_.erase(connectionId);
        LOG("erased from sockets_? %d", erased);
    }
    roomManager_->leaveAll(connectionId);
    rateLimiter_->resetConnection(connectionId);
    backpressureManager_->removeConnection(connectionId);
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
            LOG("removed from connections_ and user maps");
        } else {
            LOG("connectionId not found in connections_");
        }
    }
    metrics_.activeConnections.fetch_sub(1, std::memory_order_relaxed);
    LOG("cleanup complete for %s", connectionId.c_str());
}

// ── Async operation queue ─────────────────────────────────────────────

void WebSocketServer::enqueueOp(OpType type, const std::string& arg1, const std::string& arg2) {
    LOG("type=%d, arg1=%s, arg2=%s", (int)type, arg1.c_str(), arg2.c_str());
    {
        std::lock_guard<std::mutex> lock(pendingMutex_);
        pendingOps_.push({type, arg1, arg2});
        LOG("op pushed, queue size=%zu", pendingOps_.size());
    }
    if (async_) {
        LOG("deferring execution on uWS loop");
        static_cast<uWS::Loop*>(async_)->defer([this]() { executePendingOperations(); });
    } else {
        LOG("async_ is null, cannot defer; ops will be executed when loop starts?");
    }
}

void WebSocketServer::executePendingOperations() {
    LOG("executePendingOperations called");
    std::queue<PendingOp> ops;
    {
        std::lock_guard<std::mutex> lock(pendingMutex_);
        ops.swap(pendingOps_);
        LOG("swapped ops, queue size now=%zu", pendingOps_.size());
    }

    auto* app = static_cast<NativeApp*>(app_);
    if (!app) {
        LOG("app_ is null, cannot execute ops");
        return;
    }

    while (!ops.empty()) {
        PendingOp& op = ops.front();
        LOG("processing op type=%d, arg1=%s, arg2=%s", (int)op.type, op.arg1.c_str(), op.arg2.c_str());

        switch (op.type) {
        case OpType::SEND_TO_CONNECTION: {
            LOG("SEND_TO_CONNECTION: conn=%s", op.arg1.c_str());
            std::unique_lock<std::shared_mutex> lock(socketMutex_);
            auto it = sockets_.find(op.arg1);
            if (it != sockets_.end()) {
                auto* ws = static_cast<NativeWS*>(it->second);
                lock.unlock();
                size_t bytes = op.arg2.size();
                ws->send(op.arg2, uWS::OpCode::TEXT);
                LOG("sent %zu bytes to %s", bytes, op.arg1.c_str());
                metrics_.totalMessagesSent.fetch_add(1, std::memory_order_relaxed);
                metrics_.totalBytesSent.fetch_add(bytes, std::memory_order_relaxed);
                {
                    std::lock_guard<std::mutex> um(userMapMutex_);
                    auto ci = connections_.find(op.arg1);
                    if (ci != connections_.end()) {
                        ci->second.messagesSent++;
                        ci->second.bytesSent += bytes;
                        ci->second.lastSeen = std::chrono::steady_clock::now();
                        LOG("updated connection info for %s", op.arg1.c_str());
                    }
                }
            } else {
                LOG("connection %s not found in sockets_", op.arg1.c_str());
            }
            break;
        }
        case OpType::BROADCAST_TO_ROOM: {
            LOG("BROADCAST_TO_ROOM: room=%s, messageLen=%zu", op.arg1.c_str(), op.arg2.size());
            std::string messageId = generateConnectionId();
            size_t bytes = op.arg2.size();
            size_t recipients = roomManager_->getRoomSize(op.arg1);
            app->publish(op.arg1, op.arg2, uWS::OpCode::TEXT, compressionEnabled_);
            broadcastHistory_->store(op.arg1, op.arg2, messageId);
            metrics_.totalMessagesSent.fetch_add(recipients, std::memory_order_relaxed);
            metrics_.totalBytesSent.fetch_add(bytes * recipients, std::memory_order_relaxed);
            LOG("broadcast to room %s: %zu recipients, %zu bytes", op.arg1.c_str(), recipients, bytes);
            break;
        }
        case OpType::JOIN_ROOM: {
            LOG("JOIN_ROOM: conn=%s, room=%s", op.arg1.c_str(), op.arg2.c_str());
            {
                std::unique_lock<std::shared_mutex> lock(socketMutex_);
                auto it = sockets_.find(op.arg1);
                if (it != sockets_.end()) {
                    static_cast<NativeWS*>(it->second)->subscribe(op.arg2);
                    LOG("subscribed %s to %s", op.arg1.c_str(), op.arg2.c_str());
                } else {
                    LOG("socket for %s not found", op.arg1.c_str());
                }
            }
            roomManager_->join(op.arg1, op.arg2);
            {
                std::lock_guard<std::mutex> um(userMapMutex_);
                auto ci = connections_.find(op.arg1);
                if (ci != connections_.end()) {
                    ci->second.rooms.push_back(op.arg2);
                    LOG("updated connection %s room list", op.arg1.c_str());
                }
            }

            // ── FIRE CONFIRMATION AFTER SUBSCRIBE (via message TSFN) ──
            auto* d = new MessageData{
                .connectionId = op.arg1,
                .message      = "__joinConfirmed:" + op.arg2,
                .bytes        = 0,
            };
            LOG("firing join confirmation via message TSFN for %s room %s", op.arg1.c_str(), op.arg2.c_str());
            callMessageTSFN(onMessageCallback_, d);
            break;
        }
        case OpType::LEAVE_ROOM: {
            LOG("LEAVE_ROOM: conn=%s, room=%s", op.arg1.c_str(), op.arg2.c_str());
            {
                std::unique_lock<std::shared_mutex> lock(socketMutex_);
                auto it = sockets_.find(op.arg1);
                if (it != sockets_.end()) {
                    static_cast<NativeWS*>(it->second)->unsubscribe(op.arg2);
                    LOG("unsubscribed %s from %s", op.arg1.c_str(), op.arg2.c_str());
                }
            }
            roomManager_->leave(op.arg1, op.arg2);
            {
                std::lock_guard<std::mutex> um(userMapMutex_);
                auto ci = connections_.find(op.arg1);
                if (ci != connections_.end()) {
                    auto& rooms = ci->second.rooms;
                    rooms.erase(std::remove(rooms.begin(), rooms.end(), op.arg2), rooms.end());
                    LOG("removed room from connection %s", op.arg1.c_str());
                }
            }
            break;
        }
        case OpType::DISCONNECT: {
            LOG("DISCONNECT: conn=%s", op.arg1.c_str());
            {
                std::unique_lock<std::shared_mutex> lock(socketMutex_);
                auto it = sockets_.find(op.arg1);
                if (it != sockets_.end()) {
                    auto* ws = static_cast<NativeWS*>(it->second);
                    lock.unlock();
                    ws->end(0, "");
                    LOG("ended socket for %s", op.arg1.c_str());
                } else {
                    LOG("socket for %s not found", op.arg1.c_str());
                }
            }
            break;
        }
        case OpType::SHUTDOWN: {
            LOG("SHUTDOWN: closing listen socket and all connections");
            if (listenSocket_) {
                us_listen_socket_close(0, static_cast<us_listen_socket_t*>(listenSocket_));
                listenSocket_ = nullptr;
                LOG("listen socket closed");
            }
            {
                std::unique_lock<std::shared_mutex> lock(socketMutex_);
                for (auto& pair : sockets_) {
                    static_cast<NativeWS*>(pair.second)->end(0, "");
                    LOG("ended socket for %s", pair.first.c_str());
                }
                sockets_.clear();
                LOG("all sockets cleared");
            }
            break;
        }
        }

        ops.pop();
        LOG("op popped");
    }
    LOG("executePendingOperations complete");
}

// ══════════════════════════════════════════════════════════════════════
//  runServer — executed on the background thread
// ══════════════════════════════════════════════════════════════════════

void WebSocketServer::runServer() {
    LOG("runServer started on thread %lu", std::hash<std::thread::id>{}(std::this_thread::get_id()));
    auto host               = host_;
    auto port               = port_;
    auto compressionEnabled = compressionEnabled_;
    auto compressionLevel   = compressionLevel_;
    auto idleTimeout        = idleTimeoutSeconds_;
    auto maxPayload         = maxPayloadBytes_;
    auto hwm                = highWaterMark_;

    auto* app = new NativeApp();
    app_ = app;
    LOG("NativeApp created");

    WebSocketServer* self = this;

    async_ = uWS::Loop::get();
    LOG("async_ set to uWS::Loop");
    loopReadyCv_.notify_all();
    LOG("loopReadyCv notified");

    app->ws<PerSocketData>("/*", {
        .compression      = compressionEnabled ? uWS::SHARED_COMPRESSOR : uWS::DISABLED,
        .maxPayloadLength = maxPayload,
        .idleTimeout      = static_cast<int32_t>(idleTimeout),
        .maxBackpressure  = static_cast<uint32_t>(hwm),

        .upgrade = [self](auto* res, auto* req, auto* context) {
            LOG("upgrade callback entered");
            std::string ip   = extractIP(res, req);
            std::string path(req->getUrl());
            LOG("upgrade: ip=%s, path=%s", ip.c_str(), path.c_str());

            if (!self->connectionThrottler_->allowConnection(ip)) {
                self->metrics_.rejectedConnections.fetch_add(1, std::memory_order_relaxed);
                LOG("connection rejected due to throttling for ip %s", ip.c_str());
                res->close();
                return;
            }

            std::string connId = self->generateConnectionId();
            LOG("upgrade: generated connId=%s", connId.c_str());

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
            context);
            LOG("upgrade completed for %s", connId.c_str());
        },

        .open = [self](auto* ws) {
            auto* data = ws->getUserData();
            LOG("open callback: connectionId=%s, ip=%s", data->connectionId.c_str(), data->ip.c_str());
            data->connectedAt = std::chrono::steady_clock::now();
            data->lastSeen    = data->connectedAt;

            {
                std::unique_lock<std::shared_mutex> lock(self->socketMutex_);
                self->sockets_[data->connectionId] = ws;
                LOG("added socket for %s", data->connectionId.c_str());
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
                LOG("added connection info for %s", data->connectionId.c_str());
            }

            self->metrics_.totalConnections.fetch_add(1, std::memory_order_relaxed);
            self->metrics_.activeConnections.fetch_add(1, std::memory_order_relaxed);

            auto* d = new OpenData{
                .connectionId = data->connectionId,
                .ip           = data->ip,
                .userId       = data->userId,
                .path         = data->path,
            };
            LOG("calling open TSFN for %s", data->connectionId.c_str());
            callOpenTSFN(self->onOpenCallback_, d);
        },

        .message = [self](auto* ws, std::string_view message, uWS::OpCode opCode) {
            auto* data = ws->getUserData();
            LOG("message callback: connectionId=%s, messageLen=%zu", data->connectionId.c_str(), message.size());
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
                    LOG("updated connection info for %s", data->connectionId.c_str());
                }
            }

            if (!self->rateLimiter_->checkRateLimit(data->connectionId)) {
                self->metrics_.droppedMessages.fetch_add(1, std::memory_order_relaxed);
                LOG("rate limit hit, dropping message from %s", data->connectionId.c_str());
                return;
            }
            if (!self->rateLimiter_->checkPayloadSize(bytes)) {
                self->metrics_.droppedMessages.fetch_add(1, std::memory_order_relaxed);
                LOG("payload too large (%zu bytes), dropping from %s", bytes, data->connectionId.c_str());
                return;
            }

            auto* d = new MessageData{
                .connectionId = data->connectionId,
                .message      = std::string(message),
                .bytes        = bytes,
            };
            LOG("calling message TSFN for %s", data->connectionId.c_str());
            callMessageTSFN(self->onMessageCallback_, d);

            (void)opCode;
        },

        .drain = [self](auto* ws) {
            auto* data = ws->getUserData();
            LOG("drain callback: connectionId=%s", data->connectionId.c_str());
            self->backpressureManager_->onDrain(data->connectionId);

            auto* d = new DrainData{.connectionId = data->connectionId};
            callDrainTSFN(self->onDrainCallback_, d);
        },

        .close = [self](auto* ws, int code, std::string_view message) {
            auto* data = ws->getUserData();
            LOG("close callback: connectionId=%s, code=%d", data->connectionId.c_str(), code);
            std::string connId = data->connectionId;

            auto* d = new CloseData{
                .connectionId = connId,
                .code         = code,
                .reason       = std::string(message),
            };
            callCloseTSFN(self->onCloseCallback_, d);

            self->cleanupConnection(connId);
            LOG("close callback complete for %s", connId.c_str());
        },
    });

    LOG("app->ws configured, calling listen");
    app->listen(host, port, [self](auto* listenSocket) {
        if (!listenSocket) {
            fprintf(stderr, "[elysiajscppws] FATAL: failed to bind to port\n");
            LOG("listen failed on %s:%d", self->host_.c_str(), self->port_);
        } else {
            self->listenSocket_ = listenSocket;
            LOG("listen succeeded on %s:%d", self->host_.c_str(), self->port_);
        }
    });

    LOG("calling app->run()");
    app->run();
    LOG("app->run() returned");

    async_ = nullptr;
    delete static_cast<NativeApp*>(app_);
    app_ = nullptr;
    LOG("runServer exiting");
}

// ══════════════════════════════════════════════════════════════════════
//  N-API methods — called from the JS thread
// ══════════════════════════════════════════════════════════════════════

// ── Lifecycle ────────────────────────────────────────────────────────

Napi::Value WebSocketServer::start(const Napi::CallbackInfo& info) {
    LOG("start called");
    Napi::Env env = info.Env();
    if (running_) {
        LOG("server already running");
        Napi::Error::New(env, "WebSocket server is already running").ThrowAsJavaScriptException();
        return env.Null();
    }

    stopped_      = false;
    listenSocket_ = nullptr;
    async_        = nullptr;

    if (wsThread_.joinable()) {
        LOG("previous thread still joinable, error");
        Napi::Error::New(env,
            "Internal error: previous server thread was not joined before restart")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    {
        std::lock_guard<std::mutex> lock(pendingMutex_);
        std::queue<PendingOp> empty;
        pendingOps_.swap(empty);
        LOG("pending ops cleared");
    }

    {
        std::unique_lock<std::shared_mutex> lock(socketMutex_);
        sockets_.clear();
        LOG("sockets_ cleared");
    }
    {
        std::lock_guard<std::mutex> lock(userMapMutex_);
        connections_.clear();
        userToConnection_.clear();
        LOG("connections_ and userToConnection_ cleared");
    }

    running_ = true;
    metrics_.startedAt = std::chrono::steady_clock::now();
    LOG("starting background thread");
    wsThread_ = std::thread(&WebSocketServer::runServer, this);

    std::unique_lock<std::mutex> lk(loopReadyMutex_);
    loopReadyCv_.wait(lk, [this] { return async_ != nullptr || !running_; });
    LOG("start complete, async_=%p, running_=%d", (void*)async_, running_.load());

    return Napi::Boolean::New(env, true);
}

// ── stop() — now guarded against concurrent calls ────────────────────

Napi::Value WebSocketServer::stop(const Napi::CallbackInfo& info) {
    LOG("stop called");
    Napi::Env env = info.Env();

    std::lock_guard<std::mutex> lock(stopMutex_);
    if (stopped_.exchange(true)) {
        LOG("already stopped");
        return Napi::Boolean::New(env, false);
    }

    running_ = false;
    enqueueOp(OpType::SHUTDOWN, "", "");
    if (wsThread_.joinable()) {
        LOG("joining worker thread");
        wsThread_.join();
        LOG("worker thread joined");
    }

    // Release TSFNs (safe even if destructor later tries again)
    if (onOpenCallback_)          { onOpenCallback_.Release();          onOpenCallback_          = Napi::ThreadSafeFunction(); LOG("released onOpenCallback_"); }
    if (onMessageCallback_)       { onMessageCallback_.Release();       onMessageCallback_       = Napi::ThreadSafeFunction(); LOG("released onMessageCallback_"); }
    if (onCloseCallback_)         { onCloseCallback_.Release();         onCloseCallback_         = Napi::ThreadSafeFunction(); LOG("released onCloseCallback_"); }
    if (onDrainCallback_)         { onDrainCallback_.Release();         onDrainCallback_         = Napi::ThreadSafeFunction(); LOG("released onDrainCallback_"); }

    LOG("stop complete");
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::isRunning(const Napi::CallbackInfo& info) {
    bool running = running_.load();
    LOG("isRunning=%d", running);
    return Napi::Boolean::New(info.Env(), running);
}

// ── Room operations ───────────────────────────────────────────────────

Napi::Value WebSocketServer::joinRoom(const Napi::CallbackInfo& info) {
    LOG("joinRoom called");
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "joinRoom(connectionId: string, room: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string connId = info[0].As<Napi::String>().Utf8Value();
    std::string room = info[1].As<Napi::String>().Utf8Value();
    LOG("enqueue JOIN_ROOM for %s, %s", connId.c_str(), room.c_str());
    enqueueOp(OpType::JOIN_ROOM, connId, room);
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::leaveRoom(const Napi::CallbackInfo& info) {
    LOG("leaveRoom called");
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "leaveRoom(connectionId: string, room: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string connId = info[0].As<Napi::String>().Utf8Value();
    std::string room = info[1].As<Napi::String>().Utf8Value();
    LOG("enqueue LEAVE_ROOM for %s, %s", connId.c_str(), room.c_str());
    enqueueOp(OpType::LEAVE_ROOM, connId, room);
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::broadcastToRoom(const Napi::CallbackInfo& info) {
    LOG("broadcastToRoom called");
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "broadcastToRoom(room: string, message: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string room = info[0].As<Napi::String>().Utf8Value();
    std::string msg = info[1].As<Napi::String>().Utf8Value();
    LOG("enqueue BROADCAST_TO_ROOM for %s, len=%zu", room.c_str(), msg.size());
    enqueueOp(OpType::BROADCAST_TO_ROOM, room, msg);
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::getRoomInfo(const Napi::CallbackInfo& info) {
    LOG("getRoomInfo called");
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "getRoomInfo(room: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string room = info[0].As<Napi::String>().Utf8Value();
    LOG("room=%s", room.c_str());

    Napi::Object result = Napi::Object::New(env);
    result.Set("name", Napi::String::New(env, room));
    size_t size = roomManager_->getRoomSize(room);
    result.Set("size", Napi::Number::New(env, static_cast<double>(size)));

    auto conns = roomManager_->getConnectionsInRoom(room);
    Napi::Array arr = Napi::Array::New(env, conns.size());
    for (size_t i = 0; i < conns.size(); ++i)
        arr.Set(i, Napi::String::New(env, conns[i]));
    result.Set("connections", arr);
    LOG("returning room info: size=%zu", size);
    return result;
}

// ── Direct messaging ─────────────────────────────────────────────────

Napi::Value WebSocketServer::sendToConnection(const Napi::CallbackInfo& info) {
    LOG("sendToConnection called");
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "sendToConnection(connectionId: string, message: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string connId = info[0].As<Napi::String>().Utf8Value();
    std::string msg = info[1].As<Napi::String>().Utf8Value();
    LOG("enqueue SEND_TO_CONNECTION for %s, len=%zu", connId.c_str(), msg.size());
    enqueueOp(OpType::SEND_TO_CONNECTION, connId, msg);
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::sendToUser(const Napi::CallbackInfo& info) {
    LOG("sendToUser called");
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        LOG("invalid arguments");
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
    if (connId.empty()) {
        LOG("user %s not found", userId.c_str());
        return Napi::Boolean::New(env, false);
    }
    LOG("found user %s -> connection %s", userId.c_str(), connId.c_str());
    enqueueOp(OpType::SEND_TO_CONNECTION, connId, message);
    return Napi::Boolean::New(env, true);
}

// ── Connection management ────────────────────────────────────────────

Napi::Value WebSocketServer::disconnect(const Napi::CallbackInfo& info) {
    LOG("disconnect called");
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "disconnect(connectionId: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string connId = info[0].As<Napi::String>().Utf8Value();
    LOG("enqueue DISCONNECT for %s", connId.c_str());
    enqueueOp(OpType::DISCONNECT, connId, "");
    return Napi::Boolean::New(env, true);
}

Napi::Value WebSocketServer::getConnectionCount(const Napi::CallbackInfo& info) {
    uint64_t count = metrics_.activeConnections.load(std::memory_order_relaxed);
    LOG("active connections=%llu", (unsigned long long)count);
    return Napi::Number::New(info.Env(), static_cast<double>(count));
}

Napi::Value WebSocketServer::getConnectionInfo(const Napi::CallbackInfo& info) {
    LOG("getConnectionInfo called");
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "getConnectionInfo(connectionId: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string connId = info[0].As<Napi::String>().Utf8Value();
    LOG("connectionId=%s", connId.c_str());

    ConnectionInfo ci;
    bool found = false;
    {
        std::lock_guard<std::mutex> lock(userMapMutex_);
        auto it = connections_.find(connId);
        if (it != connections_.end()) { ci = it->second; found = true; }
    }
    if (!found) {
        LOG("connection %s not found", connId.c_str());
        return env.Null();
    }

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
    LOG("returning connection info for %s", connId.c_str());
    return result;
}

// ── Metrics ───────────────────────────────────────────────────────────

Napi::Value WebSocketServer::getMetrics(const Napi::CallbackInfo& info) {
    LOG("getMetrics called");
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
    LOG("metrics returned");
    return r;
}

// ── Configuration ─────────────────────────────────────────────────────

Napi::Value WebSocketServer::configure(const Napi::CallbackInfo& info) {
    LOG("configure called");
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "configure requires an options object").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Object opts = info[0].As<Napi::Object>();

    if (opts.Has("host"))            host_               = opts.Get("host").As<Napi::String>().Utf8Value();
    if (opts.Has("port"))            port_               = opts.Get("port").As<Napi::Number>().Int32Value();
    if (opts.Has("idleTimeout"))     idleTimeoutSeconds_ = opts.Get("idleTimeout").As<Napi::Number>().Int32Value();
    if (opts.Has("maxPayloadBytes")) maxPayloadBytes_    = opts.Get("maxPayloadBytes").As<Napi::Number>().Int32Value();
    LOG("config: host=%s, port=%d, idleTimeout=%d, maxPayload=%d",
        host_.c_str(), port_, idleTimeoutSeconds_, maxPayloadBytes_);

    if (opts.Has("compression")) {
        Napi::Value cv = opts.Get("compression");
        if (cv.IsBoolean()) compressionEnabled_ = cv.As<Napi::Boolean>().Value();
        else if (cv.IsObject()) {
            compressionEnabled_ = true;
            Napi::Object co = cv.As<Napi::Object>();
            if (co.Has("level")) compressionLevel_ = co.Get("level").As<Napi::Number>().Int32Value();
        }
        LOG("compression enabled=%d, level=%d", compressionEnabled_, compressionLevel_);
    }

    if (opts.Has("highWaterMarkBytes")) {
        highWaterMark_ = static_cast<size_t>(opts.Get("highWaterMarkBytes").As<Napi::Number>().Int64Value());
        backpressureManager_ = std::make_unique<BackpressureManager>(highWaterMark_);
        LOG("highWaterMark=%zu", highWaterMark_);
    }
    if (opts.Has("maxConnectionsPerIP")) {
        int max = opts.Get("maxConnectionsPerIP").As<Napi::Number>().Int32Value();
        connectionThrottler_ = std::make_unique<ConnectionThrottler>(max);
        LOG("maxConnectionsPerIP=%d", max);
    }
    if (opts.Has("maxMessagesPerMinute")) {
        int max = opts.Get("maxMessagesPerMinute").As<Napi::Number>().Int32Value();
        rateLimiter_ = std::make_unique<RateLimiter>(max, maxPayloadBytes_);
        LOG("maxMessagesPerMinute=%d", max);
    }
    if (opts.Has("maxHistoryPerRoom")) {
        size_t max = static_cast<size_t>(opts.Get("maxHistoryPerRoom").As<Napi::Number>().Int32Value());
        broadcastHistory_ = std::make_unique<BroadcastHistory>(max);
        LOG("maxHistoryPerRoom=%zu", max);
    }

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
    LOG("configure complete");
    return r;
}

// ── History ───────────────────────────────────────────────────────────

Napi::Value WebSocketServer::getHistory(const Napi::CallbackInfo& info) {
    LOG("getHistory called");
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        LOG("invalid arguments");
        Napi::TypeError::New(env, "getHistory(room: string [, sinceTimestamp: number])")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string room = info[0].As<Napi::String>().Utf8Value();
    int64_t since = 0;
    if (info.Length() >= 2 && info[1].IsNumber())
        since = info[1].As<Napi::Number>().Int64Value();
    LOG("room=%s, since=%lld", room.c_str(), (long long)since);

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
    LOG("returning %zu history entries", entries.size());
    return arr;
}

} // namespace elysiacppws

//THIS IS A VERY LOGGED CPP CODE THAT WILL HELP US ATLEAST UNDERSTAND WHAT IS HAPPENING WITH THE TIMEOUT ERROR 
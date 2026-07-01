# Section 7 — Room Join / Broadcast Race Condition
## Investigation Log (a.k.a the bug that refused to die)

---

## What the test expects

```
c1 joins "general"   → receives { event: "joined", room: "general" }
c2 joins "general"   → receives { event: "joined", room: "general" }
c1 broadcasts        → c2 receives { event: "message", text: "hello room" }
```

Simple. Clean. Lies.

---

## Root cause (the real one, we're pretty sure)

`native.joinRoom()` enqueues a `JOIN_ROOM` op on the JS thread.  
The uWS thread picks it up *later* and calls `ws->subscribe(topic)`.  
But JS sends the `"joined"` ack **immediately after enqueuing** — before `subscribe()` has run.  
Test sees the ack → fires broadcast → `app->publish()` runs → c2 isn't subscribed yet → silence → timeout.

```
JS thread                          uWS thread
─────────────────────────────────────────────
enqueue JOIN_ROOM  ─────────────────────────►  (queued, not yet processed)
send "joined" ack  ◄── TEST SEES THIS
test fires broadcast
enqueue BROADCAST  ─────────────────────────►  (queued)
                                               drain queue:
                                               1. BROADCAST runs  ← publish() fires HERE
                                               2. JOIN_ROOM runs  ← subscribe() runs HERE
                                                                     (too late, missed it)
```

---

## Everything we tried

### Fix 1 — `stopped_` latch reset in C++ `start()` ✅ FIXED (different bug)
- `stop()` set `stopped_ = true` permanently
- Second call to `stop()` would silently no-op, leaving `wsThread_` joinable
- `std::thread` destructor on joinable thread → `std::terminate()` → zombie process
- **Fixed by:** adding `stopped_ = false` at top of `start()`

### Fix 2 — Full lifecycle reset in `start()` ✅ FIXED (same bug, more thorough)
- Added clearing of `sockets_`, `connections_`, `pendingOps_`, `listenSocket_`, `async_`
- Added guard: if `wsThread_.joinable()` on entry to `start()`, throw instead of silently breaking
- **Result:** zombie process gone, Ctrl-C works, `terminate called without an active exception` gone

### Fix 3 — `async onMessage` handler in test server ✅ APPLIED (necessary but not sufficient)
- Added `async` to `.onMessage()` callback in `startTestServer()`
- Added `await ctx.join(msg.room)` in the `'join'` case
- **Problem:** `ctx.join()` was still returning `void` / `undefined` so `await` was decorative

### Fix 4 — Option B: C++ `onJoinConfirmed` TSFN ❌ BUN SEGFAULT
- Added `JoinConfirmData` struct to header
- Added `onJoinConfirmedCallback_` TSFN member
- Added `setOnJoinConfirmed()` N-API method
- After `ws->subscribe()` in `JOIN_ROOM`, fire the confirm TSFN
- JS `RoomManager.join()` returns a Promise resolved by that confirm
- **Result:** Bun segfaulted with RSS 1.11GB. Bun's NAPI `NonBlockingCall` handling 
  does not play nice with a second concurrent TSFN the same way Node.js does.

### Fix 5 — `__joinConfirmed:` prefix through existing message TSFN ❌ NOT FULLY APPLIED
- Instead of new TSFN, piggyback confirmation through `onMessageCallback_`
- C++ sends internal message `"__joinConfirmed:roomName"` after `subscribe()`
- JS intercepts prefix before routing to user handler
- `RoomManager` uses EventEmitter to resolve pending join Promises
- **Result:** Person other than Claude was applying changes, got lost in the diffs

### Fix 6 — Dual `pendingJoins` maps discovered and cleaned up ✅ PARTIALLY FIXED
- `index.ts` had its OWN `pendingJoins` map resolved by `setOnJoinConfirmed`
- `RoomManager` had a SEPARATE `pendingJoins` map + EventEmitter
- C++ confirm fired → resolved `index.ts` map → `RoomManager`'s map never notified
- `ctx.join()` waited forever → 2s timeout → resolved anyway → orphaned map entries = memory leak
- **Fixed by:** removing `index.ts`'s map, routing everything through `RoomManager` only
- Added `cancelPendingJoins(connectionId)` called on disconnect
- Added `destroy()` that resolves all pending joins on shutdown

### Fix 7 — `configure()` nuking the join callback ✅ FIXED (sneaky little gremlin)
- `RoomManager` constructor called `setOnJoinConfirmed` to register the confirm callback
- Then `initialize()` called `native.configure()` which internally called `registerCallbacks()`
- `registerCallbacks()` released `onJoinConfirmedCallback_` and never re-set it
- Callback gone. Promises sleeping forever. Section 7 still broken.
- **Fixed by:** calling `setOnJoinConfirmed` AFTER `configure()` in `initialize()`
- Removed `setOnJoinConfirmed` from `RoomManager` constructor

### Fix 8 — `getRoomSize is not a function` in section 3 ✅ FIXED
- `getRoomSize()` went AWOL from `room-manager.ts` during one of the many edits
- Section 3 creates a bare `RoomManager` with no server → `join()` was awaiting C++ confirm
  that would never come because nothing was running
- **Fixed by:** adding `getRoomSize()` back and adding `!this.native.isRunning()` fallback check

---

## Current state

- Sections 1–6: ✅ all passing
- Section 3: ✅ fixed (getRoomSize restored + isRunning() fallback)
- Section 7: ❌ STILL timing out — "joined" ack fires before `ws->subscribe()` executes
- Sections 8–14: never reached because 7 crashes the suite

---

## What SHOULD fix it (not yet confirmed working end-to-end)

The `__joinConfirmed:` prefix approach (Fix 5) is the safest path because:
- Uses the existing `onMessageCallback_` TSFN (proven stable in Bun)
- No new TSFN, no new threading surface
- No Bun NAPI segfault risk

### C++ change needed (in `executePendingOperations`, `JOIN_ROOM` case):
After `ws->subscribe()` and metadata updates, send:
```cpp
auto* d = new MessageData{
    .connectionId = op.arg1,
    .message      = "__joinConfirmed:" + op.arg2,
    .bytes        = 0,
};
callMessageTSFN(onMessageCallback_, d);
```
Remove ALL `onJoinConfirmedCallback_` / `setOnJoinConfirmed` / `JoinConfirmData` code from C++.

### JS change needed (in `handleNativeMessage` in `index.ts`):
```typescript
private handleNativeMessage(connectionId: string, rawData: string): void {
    // Intercept internal join confirmation before user handler
    if (rawData.startsWith('__joinConfirmed:')) {
        const room = rawData.slice('__joinConfirmed:'.length);
        this.roomManager._handleJoinConfirm(connectionId, room);
        return;
    }
    // ... rest of existing handler unchanged
}
```

### `RoomManager._handleJoinConfirm()` (already exists, no changes needed):
```typescript
_handleJoinConfirm(connectionId: string, room: string): void {
    const key = `${connectionId}:${room}`;
    const resolve = this.pendingJoins.get(key);
    if (resolve) {
        this.pendingJoins.delete(key);
        resolve();
    }
}
```

---

## Why this approach is safer than the TSFN approach

| | New TSFN (`setOnJoinConfirmed`) | `__joinConfirmed:` prefix |
|---|---|---|
| New NAPI surface | Yes → Bun segfault | No |
| Thread safety | Needs careful release on stop/destroy | Reuses proven TSFN |
| Code complexity | High (new struct, method, Init registration, stop/dtor releases) | Low (one `startsWith` check) |
| Bun compatible | ❌ proven broken | ✅ existing TSFN already works |

---

## Files involved

| File | Status |
|------|--------|
| `src/cpp/websocket_core.cpp` | Needs `__joinConfirmed:` message sent after `subscribe()`, remove `callJoinConfirmTSFN` |
| `src/cpp/websocket_core.h` | Remove `JoinConfirmData`, `onJoinConfirmedCallback_`, `setOnJoinConfirmed` declaration |
| `src/js/index.ts` | Add `startsWith('__joinConfirmed:')` intercept in `handleNativeMessage` |
| `src/js/room-manager.ts` | Already correct — `_handleJoinConfirm`, `cancelPendingJoins`, `destroy` all in place |
| `tests/integration/testmain.ts` | Already correct — `async onMessage`, `await ctx.join()` in place |

---

## Lessons learned (the hard way, as is tradition)

1. `configure()` will happily murder your carefully registered callbacks and say nothing about it
2. Bun's NAPI is not Node's NAPI — a second TSFN firing concurrently makes it go boom
3. Two maps tracking the same thing will always drift apart at the worst possible moment
4. A `std::thread` left joinable when its destructor runs is just `std::terminate()` waiting to happen
5. "The test is passing" and "the bug is fixed" are two completely different things when the JS mock
   hides the race condition that only appears with real C++ threading
6. section 7 has the energy of a final boss that keeps getting back up
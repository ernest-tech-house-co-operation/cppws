# Findings

## 1. Section 7 timeout — RESOLVED

**Symptom:** `testRooms()` reliably timed out on `nextMessage(c1)` after
opening two clients back-to-back. Zero C++ `message callback` logs ever
fired for the failing run — the join message never reached the server.

**Root cause:** Listener-attached-too-late race in the test harness, not
the server. `testRooms()` opened both clients, *then* drained welcomes
sequentially:

```
open c1 → open c2 → nextMessage(c1) → nextMessage(c2)
```

The server sent c1's welcome message while the test was still busy opening
c2. By the time `nextMessage(c1)` finally attached `.onmessage`, the
message had already fired into a `null` handler and was gone — no error,
no queue, no replay. `c1.send(join)` never even executed, since the code
was still stuck awaiting a welcome that would never arrive.

Confirmed by timestamps: server sent c1's welcome at `.174`; test didn't
attach `nextMessage(c1)`'s listener until `.175`, after also finishing
c2's open.

**Fix:** `openWS()` now buffers incoming messages from the moment the
socket is constructed (before `onopen` even fires). `nextMessage()` checks
that buffer first before falling back to a live listener. No changes
needed to `testRooms()` itself or the C++ layer. See
`websocket-test-buffering.md` for the general rule.

**Verification:** Re-run after the fix — Sections 7, 8, 9 all pass cleanly
end-to-end, including join confirmation, broadcast, VIP room isolation,
leave, and leaveAll. Passed count went 51 → 78, no room/timeout failures
remaining.

**Confirmed NOT the cause (ruled out this session):**
- The join-confirmation TSFN pipeline (`__joinConfirmed:` message path) —
  fully correct, just wasn't being exercised because messages never
  reached the server in the failing runs.
- Any C++/threading issue — the C++ logs show clean, fast, correctly
  ordered execution throughout (`sent 52 bytes to ...` for both clients,
  no dropped ops, no thread contention).

---

## 2. Section 11 failure — NEW, unrelated to Section 7

**Symptom:**

```
[start:1022] start called
[start:1025] server already running
❌ Unexpected test error: Error: WebSocket server is already running
```

Fires when the rate-limiter test (`Section 11`) tries to start a second
server on port 7332 while the main server (port 7331) is still running.

**Root cause:** The native addon is a **process-wide singleton**
(`loadNative() returns cached singleton` — confirmed in Section 1's own
logs). Every `ws({...})` call — regardless of port — configures and starts
the *same* underlying native object, which has one shared `running_` flag.
"Two servers on two ports" isn't actually two independent instances at the
native layer.

**Status:** Unfixed, needs a decision:
- Short-term: reorder tests so only one server is ever running at a time
  (shut the main server down before Section 11/13 start their own), or
- Long-term: extend the native addon to support multiple independent
  server instances if truly-parallel servers are a real requirement.

Not a race condition, not related to the buffering fix — do not conflate
the two when triaging future failures in this area.

---

## 3. `room-test.js` isolated script — checked, no fix needed

Attaches `.onmessage` synchronously, in the same tick as
`new WebSocket(...)`, before any `await`. There's no gap for a message to
arrive into a null handler, so it's already immune to the Section 7 class
of bug. If it hangs, the more likely culprits are unrelated: whether
`ctx.join()` completes before the 500ms broadcast fires, or actual room
membership state — both worth checking via the script's own
`roomManager state` logging at the 500ms and 3000ms marks.
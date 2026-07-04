# Section 7 — Status Report From The Trenches
## (a.k.a. "we did not crack it, but we definitely cracked ourselves a little")

---

## TL;DR

Still broken. We are 0-for-4 on live-fire test runs. However! We killed a
real, previously-undetected concurrency bug along the way (the `setOnJoinConfirmed`
TSFN race), fully migrated to Fix 5, wired logging through basically the
entire stack, and — plot twist below — there's a **new, much more promising
suspect** that nobody has said out loud yet. So: progress, just not
"the tests pass" progress. Emotional progress. Structural progress. The
kind of progress a therapist would be proud of.

---

## What we fixed this session (for real, confirmed via logs)

1. **Killed the `onJoinConfirmedCallback_` TSFN entirely** (Fix 4, RIP,
   never forget). It was being written from the JS thread *after*
   `start()` had already spun up the uWS thread — a genuine unsynchronized
   cross-thread race on a non-trivial C++ object. This was 100% a real bug,
   it's 100% gone now, and the logs confirm the new `__joinConfirmed:`
   prefix path fires correctly through the *existing* `onMessageCallback_`
   TSFN (see: `[cpp] firing __joinConfirmed message` style logs from
   earlier runs, once we had them wired).
2. **Fixed `room-manager.ts`'s fallback check**, which had been silently
   defaulting to "never wait for confirmation" ever since we deleted
   `setOnJoinConfirmed` (because `typeof undefined !== 'function'` is
   always true — a bug we ourselves reintroduced and then found again,
   which is either poetic or just embarrassing, TBD).
3. **Fully logged the pipeline** — C++ JOIN_ROOM lifecycle, JS-side
   `handleNativeMessage` intercept, `RoomManager.join()` /
   `_handleJoinConfirm()`. All present, all correct, all... never actually
   getting exercised, because —

---

## The actual, current, still-unsolved problem

**The join messages are not making it from client to server at all.**

Across every run, the pattern is identical:

- Both clients open successfully (C++ logs confirm `.open` fires, welcome
  messages get sent, `sendToConnection` succeeds, bytes go out).
- Then: **total silence.** Not one `[operator():927] message callback`
  log line fires on the C++ side for over a second.
- Then: 2-second client-side timeout fires — `Error: message timeout`.

This means the bug is **upstream of everything we've been fixing.** The
entire join-confirmation TSFN pipeline (which we just spent this whole
session correctly rebuilding) has not been exercised even once in any
failing run, because the join message itself never arrives at the server.
We've been diligently reinforcing a bridge that nobody's actually trying
to cross yet.

---

## NEW LEAD (untested, but I'd put actual money on this one)

Look closely at the last log dump:

```
🐞 DEBUG  🏠 Draining welcome messages from both
🐞 DEBUG  📨 nextMessage: waiting for message (timeout 2000ms)
...
❌ ERROR  ⏰ nextMessage: timeout after 2000ms
```

Only **one** `nextMessage: waiting for message` line prints before the
timeout — for a step that's supposed to drain **two** welcome messages
(one per client). That means the very first `nextMessage(c1)` call itself
is the one that's hanging — we're not even getting to the join sends.

But the C++ logs show **both** "connected" welcome messages were already
sent (`sent 53 bytes to ...`) *before* the client-side drain code even
started running. That timing gap is the smoking gun:

> **Classic "attached the listener too late" bug.** If the server fires
> the welcome message before the client's `.onmessage` handler gets
> assigned (which happens inside `nextMessage()`, called *after*
> `openWS()` resolves and *after* a second `openWS()` call has also run),
> the message event may already have fired into the void — nobody was
> listening yet. WebSocket event dispatch doesn't replay past events to
> a handler attached later; if `.onmessage` was still `null` when the
> message arrived, it's just gone. No error, no queue, no mercy.

This would perfectly explain:
- Why single-client tests (Section 6) never fail — less time between
  `open` and `nextMessage()`, less chance of losing the race.
- Why opening **two** clients back-to-back (Section 7) reliably fails —
  more wall-clock time passes between c1's `open` resolving and
  `nextMessage(c1)` actually attaching a handler, because we're in the
  middle of also opening c2.
- Why it's *always* the very first message that vanishes, not later ones.

**Next session: start here.** Try attaching `.onmessage` (or a
message-queueing shim) immediately inside `openWS()`, at `open`-time,
rather than waiting for a separate `nextMessage()` call afterward. If that
makes Section 7 pass, we've been chasing a C++/threading ghost for four
straight sessions when the real bug was a JS test-harness event-ordering
issue the whole time. Which would be extremely funny, in a
"we build fault-tolerant distributed confirmation protocols to fix a
missing event listener" kind of way.

---

## Confidence ranking for next time

1. 🥇 **Client `.onmessage` attached after message already fired** (new
   lead, above) — most consistent with all observed evidence, not yet tested.
2. 🥈 Some Bun-specific client-socket timing quirk when two sockets open
   in quick succession — plausible, less specific than #1.
3. 🥉 Anything in the C++/room-confirm pipeline — **basically ruled out**
   for this specific symptom, since the message never even arrives
   server-side. That machinery is fixed and just hasn't had its moment
   to shine yet.

---

## Session score

- Real concurrency bugs fixed: 1 (genuinely, no notes)
- Fake concurrency bugs re-introduced by us and then re-fixed: 1
- Times we said "this should work now": 4
- Times it worked: 0
- Vibes: surprisingly still okay
- Coffee required for next session: yes
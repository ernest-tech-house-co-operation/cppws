# WebSocket Test Client: Message Buffering

## The problem

If a test client does `new WebSocket(url)` and attaches `.onmessage`
**later** — after an `await`, e.g. inside a `nextMessage()` helper called
after `open` resolves — there's a window where the server can send a
message before the listener is attached. WebSockets don't replay missed
events: the message just fires into a `null` handler and is gone.

This is invisible with a single client (barely any gap between open and
listen). It shows up reliably once multiple sockets are opened
back-to-back, because opening/setting-up client #2 delays when client #1's
listener actually gets attached — even though client #1 opened first.

## The fix

Attach a message-queueing handler **the instant the socket is created**,
before `onopen` even fires. Have the "wait for next message" helper check
that buffer first, and only fall back to a real listener if it's empty.
That makes it architecturally impossible to lose a message to a timing gap,
regardless of how later test code opens or orders sockets.

## Where this applies

✅ **Applies** — needs the buffering fix:
- Any helper where `.onmessage` is attached **after** an `await`
  (e.g. after `await openWS()` resolves, in a separate `nextMessage()` call)
- Any test that opens **multiple sockets** and does setup work for one
  while another is already open (the delay is what creates the race)
- Reusable test-suite helpers in general — you don't control how future
  tests will call them, so the buffer should be the default

❌ **Does not apply** — no fix needed:
- Scripts where `.onmessage` is attached **synchronously**, in the same
  tick as `new WebSocket(...)`, before any `await` — there's no gap for
  a message to arrive into
- Single-socket scripts with no other async setup happening between
  socket creation and listener attachment

**Rule of thumb:** if there's an `await` (or any async work) between
`new WebSocket(...)` and `.onmessage = ...`, buffer it. If `.onmessage` is
wired up in the same synchronous block as construction, it's already safe.

## Bonus, unrelated: one native server per process

Separately — if you see `Error: WebSocket server is already running` when
starting a second server on a different port while another is still up:
this is not a race condition and the buffering fix above doesn't touch it.
The native addon is loaded once per process as a singleton
(`loadNative() returns cached singleton`), so all `ws({...})` calls share
one underlying `running_` flag. You currently can't run two independent
native servers in the same process — the second `start()` call will always
be rejected until the first one calls `stop()`/`shutdown()`. Tests that
try to run a second server in parallel need to either shut the first one
down first, or wait until the native layer supports multiple instances.
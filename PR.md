# Proposal: cppws — Native C++ WebSocket Server for the Elysia Ecosystem

**From:** Ernest Tech House ([github.com/Ernest12287](https://github.com/Ernest12287))
**To:** ElysiaJS maintainers & community
**Date:** June 2026

---

## An Apology, First

We owe the ElysiaJS community an honest explanation before anything else.

We shipped `elysiajscppws` as a native C++ WebSocket *plugin* for Elysia. We were excited about it, we were proud of it, and we genuinely believed we had solved something real. And in many ways we had — the C++ core, the room management, the rate limiting, the metrics, the JWT auth, all of it worked exactly as described.

But there was one thing that didn't work, and it was the most important thing: **broadcasting**.

Here's what we saw during testing:

```
[15:59:58] ✅  Echo .hello preserved (expected "world", got "world")
[15:59:58] ✅  Echo .num preserved (expected 42, got 42)
[15:59:58] ✅  Large payload echoed intact (expected 10000, got 10000)
[15:59:58] ℹ️  ══ 7. Room join / leave / broadcast ══
[15:59:58] 🐞  [WS] conn_1782651598036 left all rooms: []
[15:59:58] ℹ️  [WS] Connection closed: conn_1782651598036 (code: 1000)
[15:59:58] ℹ️  [WS] Connection opened: conn_1782651598054 (IP: unknown)
[15:59:58] 🐞  [WS] conn_1782651598054 joined room: general
[15:59:58] 🐞  [/chat] conn_1782651598054 joined general
[15:59:58] ℹ️  [WS] Connection opened: conn_1782651598057 (IP: unknown)
[15:59:58] 🐞  [WS] conn_1782651598057 joined room: general
[15:59:58] 🐞  [/chat] conn_1782651598057 joined general
[16:00:00] ❌  Unexpected test error: Error: msg timeout
[16:00:00] ✅  Passed:  51
[16:00:00] ⚠️  Skipped: 1
[16:00:00] ❌  Failed:  1
```

51 tests passing. 1 failure. And that 1 failure was the room broadcast test — the core feature of any real-time WebSocket server.

The reason was architectural and it was our fault for not catching it sooner: **when you use Elysia's `.ws()` on Bun, the sockets are owned by Bun's internal transport.** Bun holds them. Our C++ core could not reach those sockets to broadcast to them. Room broadcasts had to go through Bun's `subscribe`/`publish` API — a Bun-only primitive that doesn't exist on Node.js or Deno. We were shipping a "C++ WebSocket server" that secretly depended on Bun's JS runtime for its single most important feature.

We should have caught this earlier. We didn't. We're sorry.

**The fix is `cppws`.** Instead of trying to squeeze a C++ transport layer inside a framework that already has its own WebSocket server, cppws owns the transport completely. It runs on its own port alongside your HTTP framework. The C++ server owns every socket from the moment the upgrade handshake completes. Room broadcasts, direct messages, backpressure — all of it flows through our C++ core with zero dependency on any runtime's WebSocket primitives.

We are committed to making the Elysia WebSocket story great. This document is our updated proposal for how to do that right.

---

## Summary

**cppws** is a standalone, runtime-agnostic WebSocket server powered by a native C++ core (uWebSockets via N-API). It ships pre-compiled per-platform binaries — the same distribution model as [Sharp](https://github.com/lovell/sharp) and [esbuild](https://github.com/evanw/esbuild) — so end users need no C++ toolchain. It provides 22 production-ready features out of the box: rooms, pub/sub, rate limiting, JWT auth, backpressure management, compression, real-time metrics, event sourcing, direct messaging, and more.

It runs **alongside** your Elysia app on its own port. Elysia handles HTTP. cppws handles WebSockets. Each owns its domain completely.

---

## The Problem We Were Trying to Solve

Elysia is already the fastest TypeScript web framework, and Bun's native HTTP server is genuinely fast. But WebSocket handling — even on Bun — still runs through JavaScript. For real-time applications pushing the limits (multiplayer games, live trading dashboards, collaborative editors, chat platforms with thousands of concurrent rooms), there is a performance ceiling that pure JavaScript can't break through.

The WebSocket story in the Elysia ecosystem has real gaps:

1. **No native WebSocket acceleration.** Elysia delegates to the runtime's WebSocket implementation. Good, but not C++-level fast.
2. **No built-in room management.** Developers build their own room/pub-sub systems from scratch every time.
3. **No built-in rate limiting for WebSocket messages.** Elysia's excellent validation ecosystem doesn't extend to WebSocket message streams.
4. **No built-in authentication for WebSocket upgrades.** Tokens must be checked manually in upgrade handlers.
5. **No cross-instance coordination.** Multiple Elysia instances behind a load balancer means WebSocket connections are siloed.

We wanted to solve all five. We still do. We just had to change *how*.

---

## Why We Moved From Plugin to Standalone Server

The original `elysiajscppws` tried to integrate with Elysia's `.ws()` API and live inside the framework's lifecycle. The idea was elegant: hook into `.listen()`, intercept the WebSocket upgrade, hand the connection to our C++ core.

The problem was that Elysia's `.ws()` on Bun hands the socket to Bun's internal transport. **Bun owns those sockets.** That means:

- Our C++ `broadcastToRoom` couldn't reach Bun-owned sockets at all
- Room broadcasts had to use Bun's `subscribe`/`publish` — a Bun-only API
- The library worked on Bun (via Bun's pub/sub) but silently broke on Node.js and Deno
- We were shipping a runtime-agnostic library that was secretly Bun-only under the hood

The honest fix was to stop fighting the framework and own the transport ourselves.

When cppws owns the sockets, every feature works on every runtime — Bun, Node.js, Deno — identically, with no shims, no workarounds, no runtime detection. The C++ architecture was always correct. The only mistake was trying to bolt it onto a framework that already had its own WebSocket server.

---

## Why C++? Why uWebSockets?

**uWebSockets** is arguably the fastest WebSocket server implementation available. It's used in production at companies handling millions of concurrent connections, is lightweight, has zero unnecessary allocations, and is battle-tested.

By compiling uWebSockets into a native addon loaded via N-API, we get:

- **2–5× higher message throughput** than pure-JS WebSocket handling
- **Significantly lower memory per connection** — C++ struct allocations vs JavaScript object overhead
- **Native-level rate limiting and backpressure** — sliding window algorithms in C++ with zero GC pressure
- **Lock-free atomic metrics** — `std::atomic` counters for connection/message/byte stats

And critically: **N-API works on Bun, Node.js, and Deno.** A single compiled `.node` binary runs across all three major runtimes without recompilation. The runtime problem is solved — for real this time.

---

## Why the Sharp Distribution Model?

Same reason Sharp became the standard for image processing in the Node.js ecosystem:

1. **No compiler needed by end users.** Pre-built binaries are published as `optionalDependencies` per platform. npm resolves the right one automatically.
2. **Graceful fallback.** No binary available? The server falls back to a pure-JS mock. Your app doesn't crash — it runs with degraded performance and a warning in the logs.
3. **Familiar pattern.** Sharp, esbuild, better-sqlite3 — the ecosystem knows how to consume native addons this way.

---

## Feature Comparison

| Feature | cppws | Elysia Built-in | socket.io |
|---------|:-----:|:---------------:|:---------:|
| C++ native WebSocket core | ✅ | ❌ | ❌ |
| Pre-built binaries (no compiler) | ✅ | N/A | ❌ |
| Room management | ✅ (C++) | ❌ | ✅ (JS) |
| Pub/Sub (horizontal scaling) | ✅ (pluggable) | ❌ | ✅ (Redis adapter) |
| Sliding-window rate limiting | ✅ (C++ layer) | ❌ | ❌ |
| JWT authentication | ✅ (built-in) | Manual | ❌ |
| Backpressure management | ✅ | ❌ | ❌ |
| Per-message compression | ✅ | ❌ | ❌ |
| Message batching | ✅ | ❌ | ❌ |
| Real-time metrics (MPS, bytes) | ✅ | ❌ | ✅ |
| Event sourcing / history | ✅ | ❌ | ❌ |
| Direct user messaging | ✅ | ❌ | ✅ |
| Connection throttling (per IP) | ✅ | ❌ | ❌ |
| Typed event emitter | ✅ | ❌ | ❌ |
| Runtime-agnostic (Bun/Node/Deno) | ✅ (verified) | Bun only | ❌ |
| Works alongside Elysia | ✅ | Native | Adapter |

---

## Architecture

cppws is a sidecar WebSocket server. Your HTTP framework does what it does best; cppws does WebSockets at C++ speed.

```
┌────────────────────────────────────────┐
│          Your HTTP Framework           │
│  Elysia / Express / Hono / Fastify     │
│         (port 3000, any runtime)       │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│                cppws                   │
│  Auth · Rate Limiting · Metrics        │
│  Room Manager · History · Event Bus    │
│              ↕ N-API                   │
│  C++ Core (uWebSockets)                │
│  Rooms · Backpressure · Compression    │
│  Sliding-window Rate Limiter           │
│  Lock-free Atomic Metrics              │
└────────────────────────────────────────┘
        ↕ WebSocket (owns the transport)
┌────────────────────────────────────────┐
│    Clients (Browser / Mobile / IoT)    │
└────────────────────────────────────────┘
```

The C++ core implements:
- `RateLimiter` — sliding-window per connection
- `RoomManager` — bidirectional room↔connection maps
- `BackpressureManager` — high-water-mark tracking per connection
- `ConnectionThrottler` — per-IP connection count enforcement
- `BroadcastHistory` — per-room event sourcing with configurable retention
- `ServerMetrics` — lock-free `std::atomic` counters
- `WebSocketServer` — the N-API class exposing everything to JavaScript

The JS layer implements:
- Authentication middleware (query / header / cookie, JWT, custom validators)
- Message batching for high-throughput scenarios
- Metrics collector (polls native, computes messages/second)
- Internal event bus for decoupled component coordination
- Pure-JS mock fallback for development without compiled binaries

---

## Integration Example

```typescript
import { Elysia } from 'elysia'
import { ws } from 'cppws'

// cppws owns WebSockets on 3001
const wsServer = ws({
  port: 3001,
  rooms: true,
  security: {
    maxMessagesPerMinute: 120,
    auth: { enabled: true, source: 'query', secret: process.env.JWT_SECRET! },
  },
  history: { maxEntriesPerRoom: 200 },
})
.onOpen(ctx => {
  ctx.join('general')
  ctx.to('general').emit('user:joined', { userId: ctx.userId })
})
.onMessage((ctx, data) => {
  ctx.to('general').send({ userId: ctx.userId, text: data, time: Date.now() })
})
.onClose(ctx => {
  ctx.to('general').emit('user:left', { userId: ctx.userId })
})
.start()

// Elysia owns HTTP on 3000 — completely untouched
const app = new Elysia()
  .get('/health', () => 'ok')
  .get('/api/metrics', () => wsServer.getMetrics())
  .listen(3000)
```

---

## What We're Asking For

1. **Feedback on the new architecture.** The sidecar approach — cppws on its own port alongside Elysia — is a clean separation of concerns. We believe it's the correct model. We'd welcome input from the Elysia maintainers on whether this fits the ecosystem's direction.

2. **Consideration for ecosystem listing.** We'd love `cppws` to be listed on the Elysia ecosystem/plugins page. It fills a real gap for teams building production real-time applications that need rooms, auth, horizontal scaling, and genuine C++ throughput.

3. **Open collaboration.** We remain open to collaborating with the Elysia team, SaltyAom, or any other OSS library that wants to bring real C++ WebSocket performance into their stack. The dream that started as `elysiajscppws` lives on in `cppws` — and we'd love to build it together.

---

## What We're NOT Asking For

- We're not asking to merge this into the Elysia monorepo. The C++ toolchain requirement makes it a natural separate package.
- We're not asking Elysia to depend on this. It's `npm install cppws` — fully optional.
- We're not asking for any changes to Elysia's core. This is purely additive.

---

## Current Status

- ~1,100 lines of C++ implementing the full native core
- ~1,800 lines of TypeScript implementing the JS layer
- Full TypeScript type definitions (internal and public `.d.ts`)
- Unit, integration, security, and stress test suites (Vitest)
- Pure-JS mock fallback for development without compiled binaries
- Sharp-style binary distribution with 8 platform targets
- MIT licensed

Repository: [github.com/Ernest12287/cppws](https://github.com/Ernest12287/cppws)

---

## Why Ernest Tech House

We're shifting our main binary-to-Node.js communication layer to WebSockets and we needed something fast — fast for scraping, for taking and receiving commands on the fly, for real-time control of our nothing-browser binaries. We looked at Elysia (genuinely the best TypeScript framework we've worked with), saw that the WebSocket story had room to grow, and decided to make it better — not perfect, just better.

`elysiajscppws` was one of the most fun projects we've ever built. `cppws` is what it was always trying to be.

For more about us and our projects: [Nothing Browser Docs](https://nothing-browser-docs.pages.dev/)

---

Thank you for Elysia. Seriously. It's the reason this project exists at all, and we hope `cppws` gives something back to the community that gave us so much to work with.

**— Ernest Tech House**
# cppws

> **The fastest WebSocket library alive. Bring your framework — we run alongside it.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![C++20](https://img.shields.io/badge/C%2B%2B-20-blue.svg)](src/cpp/)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](package.json)
[![Bun](https://img.shields.io/badge/bun-compatible-orange.svg)](package.json)
[![Deno](https://img.shields.io/badge/deno-compatible-purple.svg)](package.json)
[![Runtime Agnostic](https://img.shields.io/badge/runtime-agnostic-brightgreen.svg)](package.json)

---

## What is cppws

cppws is a **standalone, runtime-agnostic WebSocket server** powered by a native C++ core (uWebSockets). It owns its own sockets, its own transport, and its own everything — no framework, no runtime, no problem.

You bring Elysia, Express, Hono, Fastify, or nothing at all. cppws runs alongside anything on its own port, handling WebSockets at native C++ speed while your HTTP framework does what it does best.

Zero runtime API dependencies. Works on Bun, Node.js, and Deno identically.

---

## Why We Moved From elysiajscppws → cppws

This library started as `elysiajscppws` — an Elysia plugin that tried to bring C++ WebSocket performance into Elysia's `.ws()` API. It wasn't a bad idea. It just hit a wall that couldn't be climbed.

**The problem:** Elysia's `.ws()` on Bun hands the WebSocket sockets to Bun's internal transport. Bun owns those sockets. That means room broadcasts had to go through Bun's `subscribe`/`publish` API — a Bun-only primitive that doesn't exist on Node.js or Deno. The C++ `broadcastToRoom` couldn't reach Bun-owned sockets at all. We were shipping a "C++ WebSocket server" that depended on Bun's JS runtime for its most important feature.

**The honest fix:** Stop fighting the framework. Own the transport completely.

When your C++ server owns the sockets, every single feature works on every runtime — no shims, no workarounds, no runtime detection. The C++ architecture was correct all along. The only mistake was trying to squeeze it inside a framework that already had its own WebSocket server baked in.

It stings to rename and rebrand. But shipping something correct is better than shipping something that only half-works on one runtime. That's why cppws exists.
But on the broght side elysia js was the fist thought because elysia ws is not top tier and this was meant to solve it and soon sure hope salty atom will see wwhy and even one time not depend on bun's apis and mybe ship a full working one we are open to collaborate with any oss lib to bring this in their ws lives thanks elysiajs for everything now cppws lives through the dresm from plugin to standalone library did not see that the last two weeks i was working on this lib 

---

## Features

| # | Feature | Description |
|---|---------|-------------|
| 1 | **C++ WebSocket Core** | uWebSockets-powered server compiled to native code via N-API |
| 2 | **Room Management** | Join/leave rooms, broadcast to rooms, room metadata queries |
| 3 | **Pub/Sub Architecture** | Pluggable adapter (Redis, NATS, Kafka) for horizontal scaling |
| 4 | **Sliding-Window Rate Limiting** | Per-connection message rate limiting with configurable thresholds |
| 5 | **JWT Authentication** | Built-in HMAC-SHA256 JWT verification with pluggable custom validators |
| 6 | **Token Source Flexibility** | Auth tokens from query params, `Authorization` header, or cookies |
| 7 | **Backpressure Management** | High-water-mark tracking; blocks writes when slow clients lag |
| 8 | **Per-Message Compression** | Configurable permessage-deflate with threshold and level control |
| 9 | **Message Batching** | Coalesces multiple sends into fewer TCP packets |
| 10 | **Real-Time Metrics** | Connections, messages/sec, bytes in/out, dropped messages, uptime |
| 11 | **Distributed Direct Messaging** | Send to a specific user ID across instances via pub/sub |
| 12 | **Broadcast History / Event Sourcing** | Per-room message history with configurable retention |
| 13 | **Reconnection State Sync** | Query missed messages since a timestamp on reconnect |
| 14 | **Connection Throttling** | Per-IP connection limit to prevent abuse |
| 15 | **Typed Event Emitter** | Fully typed `on`, `once`, `off`, `emit` for server lifecycle events |
| 16 | **Internal Event Bus** | Decoupled coordination between metrics, logging, and middleware |
| 17 | **TLS / SSL Support** | Optional OpenSSL-backed TLS for secure `wss://` connections |
| 18 | **Pure-JS Fallback** | Graceful degradation to a JS mock when no native binary is available |
| 19 | **Idle Timeout** | Automatic cleanup of zombie connections |
| 20 | **Payload Size Limits** | Configurable max payload enforced at the C++ layer |
| 21 | **Runtime Agnostic** | Identical behavior on Bun, Node.js, and Deno |
| 22 | **Framework Agnostic** | Works alongside Elysia, Express, Hono, Fastify, or standalone |

---

## Installation

```bash
npm install cppws
```

Pre-built binaries for your platform are downloaded automatically via optional dependencies. No compiler toolchain required at install time.

Supported platforms:

| Platform | Arch | Libc |
|----------|------|------|
| macOS | arm64, x64 | — |
| Linux | x64, arm64 | gnu, musl |
| Windows | x64, arm64 | MSVC |

If your platform isn't listed or the pre-built binary fails to load, cppws automatically falls back to a pure-JS mock so your app never crashes. You'll see a warning in the logs telling you to either install a prebuild or compile from source.

---

## Quick Start

```typescript
import { ws } from 'cppws'

ws({ port: 3001, rooms: true })
  .onOpen(ctx => {
    ctx.join('general')
    ctx.send({ event: 'connected', id: ctx.id })
  })
  .onMessage((ctx, data) => {
    ctx.to('general').send({ user: ctx.userId, text: data })
  })
  .onClose((ctx, code) => {
    console.log(`${ctx.id} disconnected: ${code}`)
  })
  .start()
```

Client connects to `ws://localhost:3001`. That's it.

---

## Usage With Your Framework

### Alongside Elysia

```typescript
import { Elysia } from 'elysia'
import { ws } from 'cppws'

// cppws owns WebSockets on 3001
const wsServer = ws({
  port: 3001,
  rooms: true,
  security: {
    maxMessagesPerMinute: 120,
    auth: { enabled: true, secret: 'your-jwt-secret' }
  }
})
.onOpen(ctx => {
  ctx.join('general')
  ctx.send({ event: 'connected', id: ctx.id })
})
.onMessage((ctx, data) => {
  ctx.to('general').send({ user: ctx.userId, text: data })
})
.onClose((ctx, code) => {
  console.log(`${ctx.id} left: ${code}`)
})
.start()

// Elysia owns HTTP/REST on 3000
const app = new Elysia()
  .get('/health', () => 'ok')
  .get('/metrics', () => wsServer.getMetrics())
  .get('/rooms/:room', ({ params }) => wsServer.getRooms().getRoom(params.room))
  .listen(3000)
```

---

### Alongside Express

```typescript
import express from 'express'
import { ws } from 'cppws'

const wsServer = ws({ port: 3001, rooms: true })
  .onOpen(ctx => ctx.join('general'))
  .onMessage((ctx, data) => ctx.to('general').send(data))
  .start()

const app = express()
app.get('/health', (req, res) => res.json('ok'))
app.get('/metrics', (req, res) => res.json(wsServer.getMetrics()))
app.listen(3000)
```

---

### Alongside Hono

```typescript
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { ws } from 'cppws'

const wsServer = ws({ port: 3001, rooms: true })
  .onOpen(ctx => ctx.join('general'))
  .onMessage((ctx, data) => ctx.to('general').send(data))
  .start()

const app = new Hono()
app.get('/health', (c) => c.json('ok'))
app.get('/metrics', (c) => c.json(wsServer.getMetrics()))

serve(app, () => console.log('HTTP on :3000'))
```

---

### Alongside Fastify

```typescript
import Fastify from 'fastify'
import { ws } from 'cppws'

const wsServer = ws({ port: 3001, rooms: true })
  .onOpen(ctx => ctx.join('general'))
  .onMessage((ctx, data) => ctx.to('general').send(data))
  .start()

const fastify = Fastify()
fastify.get('/health', () => 'ok')
fastify.get('/metrics', () => wsServer.getMetrics())
fastify.listen({ port: 3000 })
```

---

### Standalone — No HTTP Framework

```typescript
import { ws } from 'cppws'

ws({ port: 3001, rooms: true })
  .onOpen(ctx => {
    ctx.join('general')
    ctx.send({ event: 'connected', id: ctx.id })
  })
  .onMessage((ctx, data) => {
    ctx.to('general').send(data)
  })
  .onClose((ctx, code, reason) => {
    console.log(`disconnected: ${code} ${reason}`)
  })
  .start()
```

---

## Full Feature Example

```typescript
import { ws } from 'cppws'

const wsServer = ws({
  port: 3001,
  rooms: true,
  security: {
    maxMessagesPerMinute: 60,
    maxPayloadBytes: 1048576,
    maxConnectionsPerIP: 5,
    auth: {
      enabled: true,
      source: 'query',
      fieldName: 'token',
      secret: 'your-jwt-secret',
    },
  },
  history: { maxEntriesPerRoom: 100 },
  compression: { enabled: true, level: 3 },
  idleTimeout: 120,
})
.onOpen(async ctx => {
  ctx.join('general')

  // Send missed messages on reconnect
  const history = wsServer.getHistory('general', Date.now() - 60_000)
  ctx.send({ event: 'history', data: history })

  ctx.send({ event: 'connected', id: ctx.id, userId: ctx.userId })
})
.onMessage((ctx, data) => {
  if (data.event === 'join') {
    ctx.join(data.room)
    ctx.to(data.room).send({ event: 'joined', userId: ctx.userId })
    return
  }

  if (data.event === 'message') {
    ctx.to(data.room).send({
      event: 'message',
      userId: ctx.userId,
      text: data.text,
      time: Date.now(),
    })
    return
  }

  if (data.event === 'dm') {
    ctx.privatelySend(data.toUserId, 'dm', { from: ctx.userId, text: data.text })
    return
  }
})
.onClose((ctx, code) => {
  ctx.to('general').send({ event: 'left', userId: ctx.userId })
})
.start()
```

---

## Client Side

No special client needed. It's a standard WebSocket:

```javascript
const socket = new WebSocket('ws://localhost:3001?token=your-jwt-here')

socket.onopen = () => {
  socket.send(JSON.stringify({ event: 'join', room: 'general' }))
}

socket.onmessage = (e) => {
  const data = JSON.parse(e.data)
  console.log(data)
}

socket.onclose = (e) => {
  console.log('disconnected', e.code, e.reason)
}
```

---

## Configuration

Full options passed to `ws()`:

```typescript
ws({
  // Server
  port: 3001,
  host: '0.0.0.0',

  // Room management
  rooms: true,  // or { maxRoomsPerConnection: 50, maxConnectionsPerRoom: 1000 }

  // Security
  security: {
    maxMessagesPerMinute: 120,
    maxPayloadBytes: 1048576,       // 1MB
    maxConnectionsPerIP: 10,
    auth: {
      enabled: true,
      source: 'header',             // 'query' | 'header' | 'cookie'
      fieldName: 'token',
      validate: async (token) => {  // custom validator
        return await verifyToken(token)
      },
      // OR use built-in JWT:
      secret: 'your-jwt-secret',
    },
  },

  // Compression
  compression: {
    enabled: true,
    level: 3,                       // 0-9
    threshold: 1024,                // min bytes to compress
  },

  // Pub/Sub for horizontal scaling
  pubSub: {
    subscribe(room: string) {},
    unsubscribe(room: string) {},
    publish(room: string, message: string) {},
    onMessage(handler: (room, msg) => void) {},
  },

  // General
  idleTimeout: 120,                 // seconds
  maxPayload: 1048576,             // bytes
  highWaterMark: 1048576,          // bytes (backpressure)
  history: true,                   // or { maxEntriesPerRoom: 100 }
  batching: true,                  // or { maxBatchSize: 50, flushInterval: 10 }

  // Custom user ID extraction
  extractUserId: (ctx) => ctx.jwt?.sub,

  // TLS
  tls: { cert: '/path/to/cert.pem', key: '/path/to/key.pem' },
})
```

---

## API

### Server

```typescript
const server = ws(options)

server.onOpen(ctx => void)
server.onMessage((ctx, data) => void)
server.onClose((ctx, code, reason) => void)
server.start()
server.shutdown()

server.getMetrics()         // → WSMetrics
server.getHistory(room, since?)
server.getRooms()           // → RoomManager
server.getConnectionCount() // → number
```

### WSContext (inside handlers)

```typescript
ctx.id              // connection ID
ctx.userId          // authenticated user ID
ctx.ip              // client IP
ctx.rooms           // Set<string> of joined rooms

ctx.join(room)      // join a room
ctx.leave(room)     // leave a room
ctx.leaveAll()      // leave all rooms

ctx.send(data)                          // send to this connection
ctx.emit(event, data)                   // send typed event to this connection
ctx.to(room).send(data)                 // broadcast to room
ctx.to(room).emit(event, data)          // broadcast typed event to room
ctx.privatelySend(userId, event, data)  // send to a specific user ID

ctx.close(code?, reason?)  // disconnect this client
ctx.getInfo()              // → ConnectionInfo
```

---

## Building From Source

### Prerequisites

- CMake >= 3.15
- C++20 compiler (GCC 10+, Clang 10+, MSVC 2019+)
- libuv development headers (`apt install libuv1-dev` / `brew install libuv`)
- OpenSSL (optional, for TLS)
- Node.js >= 18
- cmake-js (`npm install -g cmake-js`)

### Build

```bash
npm install
npm run build
```

The compiled binary will be at `build/Release/cppws_native.node`.

---

## Distribution (Sharp Model)

cppws uses the same distribution model as [Sharp](https://github.com/lovell/sharp):

1. C++ source is compiled once per platform/arch.
2. Pre-built `.node` binaries are published as separate packages:
   - `@cppws/darwin-arm64`
   - `@cppws/darwin-x64`
   - `@cppws/linux-x64-gnu`
   - `@cppws/linux-x64-musl`
   - `@cppws/linux-arm64-gnu`
   - `@cppws/linux-arm64-musl`
   - `@cppws/win32-x64-msvc`
   - `@cppws/win32-arm64-msvc`
3. At install time, npm resolves the correct optional dependency for your platform.
4. The native loader tries pre-built → local build → pure-JS mock fallback.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│           Your HTTP Framework                 │
│   Elysia / Express / Hono / Fastify / none   │
│              (any port, any runtime)          │
└──────────────────────────────────────────────┘
                      │ HTTP
┌──────────────────────────────────────────────┐
│                  cppws                        │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │   Auth   │ │  Rate    │ │   Metrics   │  │
│  │Middleware│ │ Limiter  │ │  Collector  │  │
│  └──────────┘ └──────────┘ └─────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │  Room    │ │ History  │ │  Event Bus  │  │
│  │ Manager  │ │  Store   │ │  + Emitter  │  │
│  └──────────┘ └──────────┘ └─────────────┘  │
└───────────────────┬──────────────────────────┘
                    │ N-API
┌───────────────────▼──────────────────────────┐
│              C++ Core (uWebSockets)           │
│  ┌───────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ Protocol  │ │ Room Mgr │ │ Rate Limiter│ │
│  │ + Sockets │ │(C++ impl)│ │(sliding win)│ │
│  └───────────┘ └──────────┘ └─────────────┘ │
│  ┌───────────┐ ┌──────────┐ ┌─────────────┐ │
│  │Backpressure│ │ History  │ │  Connection │ │
│  │  Manager  │ │(event src)│ │  Throttler  │ │
│  └───────────┘ └──────────┘ └─────────────┘ │
│  ┌───────────┐ ┌───────────────────────────┐ │
│  │  Metrics  │ │  ThreadSafeFunction        │ │
│  │ (atomic)  │ │  Callbacks → JS event loop │ │
│  └───────────┘ └───────────────────────────┘ │
└──────────────────────────────────────────────┘
        ↕ WebSocket (owns the transport)
┌──────────────────────────────────────────────┐
│                  Clients                      │
│         Browser / Mobile / IoT / CLI         │
└──────────────────────────────────────────────┘
```

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build:cpp` | Compile C++ addon with cmake-js |
| `npm run build:ts` | Compile TypeScript to `dist/` |
| `npm run build` | Build C++ then TypeScript |
| `npm run build:release` | Optimized C++ build |
| `npm run dev` | Watch-mode TypeScript compilation |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests |
| `npm run test:stress` | Load/stress tests |
| `npm run clean` | Remove build artifacts |

---

## Logging

cppws uses [ernest-logger](https://www.npmjs.com/package/ernest-logger) for all logging:

- `debug` — room joins/leaves, batcher flush, metrics ticks
- `info` — server start/stop, connection open/close
- `warn` — rate limit hits, payload violations, throttling
- `error` — handler errors, metrics poll failures
- `security` — auth failures, rejected connections

---

## License

MIT

---

**Built by [Ernest Tech House](https://github.com/Ernest12287)**

> *Started as elysiajscppws — an Elysia plugin. Became cppws — a server that owns its transport and works everywhere. Sometimes the right architecture means starting over.*
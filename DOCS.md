# cppws — Integration Documentation

> Complete guide to integrating cppws into your application alongside any framework.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Basic Setup](#basic-setup)
4. [WSContext API](#wscontext-api)
5. [Rooms & Broadcasting](#rooms--broadcasting)
6. [Authentication](#authentication)
7. [Rate Limiting & Security](#rate-limiting--security)
8. [Compression](#compression)
9. [Message Batching](#message-batching)
10. [Metrics](#metrics)
11. [Horizontal Scaling (Pub/Sub)](#horizontal-scaling-pubsub)
12. [Event Sourcing & Reconnection](#event-sourcing--reconnection)
13. [Direct Messaging](#direct-messaging)
14. [Server Events](#server-events)
15. [TypeScript Types](#typescript-types)
16. [Full API Reference](#full-api-reference)
17. [Configuration Reference](#configuration-reference)
18. [Troubleshooting](#troubleshooting)

---
## NOTE
 Notice: never call `process.exit()` (or anything that triggers process teardown) synchronously inside a native callback — `onmessage`, `onOpen`, `onClose`, any TSFN-driven handler. Those callbacks execute *during* an N-API `NonBlockingCall` invocation, still on the call stack that the C++ thread is waiting on. `process.exit()` forces immediate native cleanup (your destructor), which tries to `join()` the same uWS thread that's mid-callback — that's a self-join, and the runtime throws `Resource deadlock avoided` and aborts instead of failing gracefully. Always defer exit/shutdown logic out of the callback with `setImmediate`/`queueMicrotask` so the native thread finishes its call and returns control to JS first — this rule applies anywhere you tear down the process or the server, not just in tests.
## Prerequisites

- **Node.js** >= 18.0.0, **Bun** latest, or **Deno** with N-API support
- **C++ toolchain** only needed if compiling from source — pre-built binaries are downloaded automatically at install time
- Any HTTP framework (Elysia, Express, Hono, Fastify) or none at all — cppws is completely framework-agnostic

## Installation

```bash
npm install cppws
```

The correct pre-built `.node` binary for your platform is resolved via npm's `optionalDependencies`. No compiler needed.

## Basic Setup

cppws runs as a **standalone WebSocket server** on its own port. It doesn't hook into your HTTP framework's lifecycle — it owns its own sockets, its own transport, and its own everything.

```typescript
import { ws } from 'cppws'

ws({ port: 3001, rooms: true })
  .onOpen(ctx => {
    console.log(`Connected: ${ctx.id}`)
    ctx.join('general')
  })
  .onMessage((ctx, data) => {
    ctx.to('general').send(data)
  })
  .onClose((ctx, code, reason) => {
    console.log(`Disconnected: ${code} ${reason}`)
  })
  .start()
```

Clients connect to `ws://localhost:3001`. Your HTTP framework runs separately on its own port — they never interfere with each other.

### Running Alongside a Framework

```typescript
import { Elysia } from 'elysia'
import { ws } from 'cppws'

// cppws owns WebSockets on 3001
const wsServer = ws({ port: 3001, rooms: true })
  .onOpen(ctx => ctx.join('general'))
  .onMessage((ctx, data) => ctx.to('general').send(data))
  .onClose((ctx, code) => console.log(`${ctx.id} left: ${code}`))
  .start()

// Elysia owns HTTP on 3000
const app = new Elysia()
  .get('/health', () => 'ok')
  .get('/metrics', () => wsServer.getMetrics())
  .listen(3000)
```

Works identically with Express, Hono, Fastify, or no framework at all. See the README for framework-specific examples.

---

## WSContext API

Every handler receives a `WSContext` object — your primary interface for interacting with the connection.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique connection identifier |
| `userId` | `string \| undefined` | Authenticated user ID (if auth is enabled) |
| `ip` | `string` | Client IP address |
| `rooms` | `Set<string>` | Rooms this connection is currently in |
| `jwt` | `any` | Decoded JWT payload (if authenticated) |

### Methods

#### `ctx.join(room: string): WSContext`

Add this connection to a room. Chainable.

```typescript
ctx.join('general').join('random')
```

#### `ctx.leave(room: string): WSContext`

Remove this connection from a room. Chainable.

```typescript
ctx.leave('general')
```

#### `ctx.leaveAll(): WSContext`

Remove this connection from all rooms. Chainable.

```typescript
ctx.leaveAll()
```

#### `ctx.send(data: any): WSContext`

Send a message to this specific connection. Objects are JSON-serialized automatically. Chainable.

```typescript
ctx.send({ hello: 'world' })
ctx.send('plain text')
```

#### `ctx.emit(event: string, data: any): WSContext`

Send a typed event. Wraps data in `{ event, data }`. Chainable.

```typescript
ctx.emit('chat', { message: 'hello' })
// Client receives: { "event": "chat", "data": { "message": "hello" } }
```

#### `ctx.to(room: string): RoomSender`

Target a room for broadcasting. Returns a `RoomSender` with `.send()` and `.emit()`.

```typescript
ctx.to('general').send('hello everyone')
ctx.to('general').emit('user:joined', { userId: ctx.userId })
```

#### `ctx.privatelySend(userId: string, event: string, data: any): void`

Send a private message to a specific user via the user-to-connection map. Routes through the pub/sub adapter automatically when the user is on a different instance.

```typescript
ctx.privatelySend('user-123', 'dm', { message: 'hey!' })
```

#### `ctx.close(code?: number, reason?: string): void`

Close the connection. Default code is `1000` (normal closure).

```typescript
ctx.close(4001, 'invalid message format')
```

#### `ctx.getInfo(): ConnectionInfo`

Get live connection statistics.

```typescript
const info = ctx.getInfo()
// {
//   id: 'conn_1701234567890_abc12345',
//   ip: '192.168.1.50',
//   userId: 'user-123',
//   rooms: ['general', 'random'],
//   connectedAt: 1701234567890,
//   lastSeen: 1701234600000,
//   messagesReceived: 42,
//   messagesSent: 17,
//   bytesReceived: 8400,
//   bytesSent: 3400,
// }
```

---

## Rooms & Broadcasting

Rooms are the core abstraction for grouping connections. A connection can be in multiple rooms simultaneously.

### Basic Room Usage

```typescript
import { ws } from 'cppws'

ws({ port: 3001, rooms: true })
  .onOpen(ctx => {
    const room = 'lobby'
    ctx.join(room)
    ctx.to(room).emit('user:joined', { userId: ctx.userId })
  })
  .onMessage((ctx, data) => {
    if (data.event === 'join') {
      ctx.join(data.room)
      ctx.to(data.room).emit('user:joined', { userId: ctx.userId })
      return
    }

    if (data.event === 'message') {
      ctx.to(data.room).send({
        userId: ctx.userId,
        text: data.text,
      })
    }
  })
  .onClose(ctx => {
    ctx.to('lobby').emit('user:left', { userId: ctx.userId })
  })
  .start()
```

### Accessing the Room Manager

```typescript
const server = ws({ port: 3001, rooms: true }).start()

// From your HTTP framework's route handler:
app.get('/rooms/:room', ({ params }) => {
  const info = server.getRooms().getRoomInfo(params.room)
  return {
    name: info.name,
    members: info.size,
    connections: info.connections,
  }
})
```

### Room Configuration

```typescript
ws({
  port: 3001,
  rooms: {
    maxRoomsPerConnection: 50,
    maxConnectionsPerRoom: 10000,
  },
})
```

---

## Authentication

Authentication is handled during the HTTP upgrade handshake before the WebSocket connection is established. Failed auth results in a `403` — the connection is never created.

### Query Parameter Token

```typescript
ws({
  port: 3001,
  security: {
    auth: {
      enabled: true,
      source: 'query',
      fieldName: 'token',
      validate: async (token) => {
        return await myAuthService.verify(token)
      },
    },
  },
})
```

Client connects with: `ws://localhost:3001?token=eyJhbG...`

### Bearer Token (Authorization Header)

```typescript
ws({
  port: 3001,
  security: {
    auth: {
      enabled: true,
      source: 'header',
    },
  },
})
```

Client sends: `Authorization: Bearer eyJhbG...` in upgrade request headers.

### Cookie-Based Auth

```typescript
ws({
  port: 3001,
  security: {
    auth: {
      enabled: true,
      source: 'cookie',
      fieldName: 'session_token',
    },
  },
})
```

### Built-In JWT Verification

Built-in HMAC-SHA256 JWT verification — no extra library needed:

```typescript
ws({
  port: 3001,
  security: {
    auth: {
      enabled: true,
      source: 'header',
      secret: 'your-256-bit-secret',
    },
  },
})
```

Verifies the JWT signature and checks `exp`. The decoded payload is available as `ctx.jwt` in all handlers.

### Custom User ID Extraction

By default, cppws looks for `ctx.jwt.sub`, `ctx.jwt.id`, or `ctx.jwt.userId`. Override it:

```typescript
ws({
  port: 3001,
  extractUserId: (ctx) => ctx.jwt?.username,
})
```

---

## Rate Limiting & Security

Rate limiting is enforced at the C++ layer (sliding window) for maximum performance.

### Configuration

```typescript
ws({
  port: 3001,
  security: {
    maxMessagesPerMinute: 120,    // per connection
    maxPayloadBytes: 1048576,     // 1MB max message size
    maxConnectionsPerIP: 10,      // per IP address
  },
})
```

When a connection exceeds the rate limit, the message is silently dropped and a `rateLimitHit` event is emitted on the internal event bus. The connection is not closed.

### Listening for Rate Limit Events

```typescript
const server = ws({
  port: 3001,
  security: { maxMessagesPerMinute: 30 },
})
.onMessage((ctx, data) => { /* ... */ })
.start()

const bus = server.getEventBus()
bus.on('rateLimitHit', ({ connectionId, droppedCount }) => {
  console.warn(`Rate limit hit for ${connectionId}. Total dropped: ${droppedCount}`)
})
```

### Connection Throttling

When `maxConnectionsPerIP` is exceeded, new connections from that IP receive a `403`. This is checked before auth to prevent token brute-forcing.

---

## Compression

Enable permessage-deflate compression for large messages:

```typescript
ws({
  port: 3001,
  compression: {
    enabled: true,
    level: 3,         // 0 (fastest) to 9 (best ratio). Default: 3.
    threshold: 1024,  // Only compress messages >= this many bytes. Default: 1024.
  },
})
```

Compression is handled entirely at the C++ layer.

---

## Message Batching

In high-throughput scenarios, batching coalesces multiple `send()` calls into fewer TCP packets:

```typescript
ws({
  port: 3001,
  batching: {
    maxBatchSize: 50,     // Flush after this many messages
    flushInterval: 10,    // Or flush every 10ms, whichever comes first
  },
})
```

Room broadcasts to the same room are coalesced into a single JSON array when multiple messages are pending.

---

## Metrics

Real-time metrics collected from C++ atomic counters.

### Programmatic Access

```typescript
const server = ws({ port: 3001 }).start()

const metrics = server.getMetrics()
// {
//   totalConnections: 1500,
//   activeConnections: 342,
//   totalMessagesReceived: 89420,
//   totalMessagesSent: 284100,
//   totalBytesReceived: 17884000,
//   totalBytesSent: 56820000,
//   droppedMessages: 12,
//   rejectedConnections: 3,
//   uptime: 3600000,
//   messagesPerSecond: 847,
//   slowClients: 0,
// }
```

### Live Metrics via HTTP

Expose metrics through your HTTP framework:

```typescript
import express from 'express'
import { ws } from 'cppws'

const wsServer = ws({ port: 3001 }).start()

const app = express()
app.get('/metrics', (req, res) => res.json(wsServer.getMetrics()))
app.listen(3000)
```

### Metrics Stream

```typescript
const collector = server.getMetricsCollector()
const unsubscribe = collector.onMetricsUpdate((m) => {
  console.log(`MPS: ${m.messagesPerSecond} | Active: ${m.activeConnections}`)
})

// Later:
unsubscribe()
```

---

## Horizontal Scaling (Pub/Sub)

When running multiple cppws instances behind a load balancer, the `pubSub` adapter distributes room broadcasts across all instances.

### Implementing a Pub/Sub Adapter

```typescript
import { PubSubAdapter } from 'cppws'

const redisAdapter: PubSubAdapter = {
  async connect() {
    // Connect to Redis
  },
  async disconnect() {
    // Disconnect from Redis
  },
  async subscribe(room: string) {
    // Subscribe to Redis channel `cppws:${room}`
  },
  async unsubscribe(room: string) {
    // Unsubscribe from Redis channel
  },
  async publish(room: string, message: string) {
    // Publish to Redis channel `cppws:${room}`
  },
  onMessage(handler: (room: string, message: string) => void) {
    // When a Redis message arrives, call handler(room, message)
    // cppws will broadcast it to local connections via the C++ server
  },
  async destroy() {
    // Clean up all connections
  },
}
```

### Using the Adapter

```typescript
ws({
  port: 3001,
  pubSub: redisAdapter,
})
```

When `broadcastToRoom` is called:
1. The message broadcasts locally to all connections on this instance
2. The message is published to the pub/sub adapter
3. Other instances receive it and broadcast to their own local connections

---

## Event Sourcing & Reconnection

cppws can store a history of messages per room. Clients can request missed messages on reconnect.

### Enable History

```typescript
ws({
  port: 3001,
  history: true,  // default: 100 entries per room
  // or:
  history: { maxEntriesPerRoom: 500 },
})
```

### Client Reconnection Flow

```typescript
let lastSeen = Date.now()

function connect() {
  const socket = new WebSocket('ws://localhost:3001')

  socket.onopen = () => {
    // Request missed messages via your HTTP API
    fetch('/api/history/general?since=' + lastSeen)
      .then(r => r.json())
      .then(messages => {
        for (const msg of messages) {
          console.log('Missed message:', msg)
        }
        lastSeen = Date.now()
      })
  }

  socket.onmessage = () => {
    lastSeen = Date.now()
  }
}
```

### Server-Side History Endpoint

```typescript
import express from 'express'
import { ws } from 'cppws'

const wsServer = ws({ port: 3001, history: true })
  .onMessage((ctx, data) => ctx.to('general').send(data))
  .start()

const app = express()
app.get('/api/history/:room', (req, res) => {
  const entries = wsServer.getHistory(req.params.room, Number(req.query.since))
  res.json(entries)
})
app.listen(3000)
```

---

## Direct Messaging

Send a message to a specific user regardless of which room they're in or which server instance they're connected to.

```typescript
.onMessage((ctx, data) => {
  if (data.event === 'dm') {
    ctx.privatelySend(data.toUserId, 'dm', {
      from: ctx.userId,
      text: data.text,
    })
  }
})
```

cppws resolves the user ID to a connection via the internal user-to-connection map. If the user is on a different instance, the pub/sub adapter routes it automatically.

---

## Server Events

The server instance extends `TypedEmitter` and emits the following events:

```typescript
import { ws } from 'cppws'

const server = ws({ port: 3001 }).start()

server.on('connection', ({ connectionId, ip }) => {
  console.log(`New connection: ${connectionId} from ${ip}`)
})

server.on('disconnection', ({ connectionId, code, reason }) => {
  console.log(`Disconnected: ${connectionId} (${code}: ${reason})`)
})

server.on('message', ({ connectionId, data }) => {
  // Every message from every connection
})

server.on('error', ({ connectionId, error }) => {
  // Errors from the native layer or handlers
})

server.on('roomBroadcast', ({ room, message }) => {
  // Every room broadcast
})
```

---

## TypeScript Types

All types are exported. Import directly:

```typescript
import type {
  WSOptions,
  WSContext,
  WSMetrics,
  WSHandler,
  ServerEvents,
  ConnectionInfo,
  RoomConfig,
  SecurityConfig,
  CompressionConfig,
  PubSubAdapter,
  HistoryEntry,
  ReconnectState,
  RoomSender,
} from 'cppws'
```

### Typed Events

```typescript
interface ChatEvents {
  'message:new': { userId: string; text: string; timestamp: number }
  'user:joined': { userId: string }
  'user:left': { userId: string }
  'typing': { userId: string }
}

ctx.emit('message:new', { userId: 'abc', text: 'hello', timestamp: Date.now() })
// TypeScript error on typo'd event name or wrong data shape
```

---

## Full API Reference

### Exports

| Export | Type | Description |
|--------|------|-------------|
| `ws` | `function` | Server factory — call with options, returns a chainable server builder |
| `WebSocketServer` | `class` | The internal server class (extends `TypedEmitter`) |
| `RoomManager` | `class` | High-level room management API |
| `MetricsCollector` | `class` | Polls native metrics and computes derived values |
| `TypedEmitter` | `class` | Generic typed event emitter |
| `loadNative` | `function` | Load the native C++ addon (returns mock if unavailable) |
| `isNativeLoaded` | `function` | Check if the native addon (not mock) is active |

### Server Builder Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `.onOpen(handler)` | `ServerBuilder` | Register open handler. Chainable. |
| `.onMessage(handler)` | `ServerBuilder` | Register message handler. Chainable. |
| `.onClose(handler)` | `ServerBuilder` | Register close handler. Chainable. |
| `.start()` | `WebSocketServer` | Start the server and return the server instance |

### WebSocketServer Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `shutdown()` | `Promise<void>` | Gracefully close all connections |
| `getHistory(room, sinceTimestamp?)` | `HistoryEntry[]` | Get broadcast history for a room |
| `getMetrics()` | `WSMetrics` | Snapshot of all server metrics |
| `getConnectionCount()` | `number` | Number of active connections |
| `getRooms()` | `RoomManager` | Room manager instance |
| `getMetricsCollector()` | `MetricsCollector` | Metrics collector instance |
| `getEventBus()` | `InternalEventBus` | Internal event bus for monitoring |

---

## Configuration Reference

### WSOptions

```typescript
interface WSOptions {
  port: number                      // required
  host?: string                     // default: '0.0.0.0'
  rooms?: boolean | RoomConfig
  security?: SecurityConfig
  compression?: CompressionConfig
  pubSub?: PubSubAdapter
  idleTimeout?: number              // seconds (default: 120)
  maxPayload?: number               // bytes (default: 1048576)
  highWaterMark?: number            // bytes (default: 1048576)
  history?: boolean | { maxEntriesPerRoom?: number }
  batching?: boolean | { maxBatchSize?: number; flushInterval?: number }
  logger?: { debug, info, warn, error }
  extractUserId?: (ctx: any) => string | undefined
  tls?: { cert: string; key: string }
}
```

### SecurityConfig

```typescript
interface SecurityConfig {
  maxMessagesPerMinute?: number     // default: 60
  maxPayloadBytes?: number          // default: 1048576
  maxConnectionsPerIP?: number      // default: 10
  auth?: AuthConfig
}
```

### AuthConfig

```typescript
interface AuthConfig {
  enabled: boolean
  source?: 'query' | 'header' | 'cookie'   // default: 'header'
  fieldName?: string                        // default: 'token'
  validate?: (token: string) => Record<string, any> | null | Promise<...>
  secret?: string                           // for built-in JWT HMAC-SHA256
}
```

### CompressionConfig

```typescript
interface CompressionConfig {
  enabled?: boolean     // default: false
  level?: number        // 0-9, default: 3
  threshold?: number    // bytes, default: 1024
}
```

### PubSubAdapter

```typescript
interface PubSubAdapter {
  connect(): void | Promise<void>
  disconnect(): void | Promise<void>
  subscribe(room: string): void | Promise<void>
  unsubscribe(room: string): void | Promise<void>
  publish(room: string, message: string): void | Promise<void>
  onMessage?(handler: (room: string, message: string) => void): void | Promise<void>
  destroy?(): void | Promise<void>
}
```

---

## Troubleshooting

### "Native C++ addon not found. Running in pure-JS mock mode."

The pre-built binary for your platform wasn't found. This is fine for development. For production:

1. **Check supported platforms** — see the platform table in the README.
2. **Compile from source**: `npm run build:cpp`
3. **Request your platform** at [github.com/Ernest12287/cppws/issues](https://github.com/Ernest12287/cppws/issues)

### "WebSocket upgrade rejected — no auth token provided"

Auth is enabled but the client didn't send a token. Double-check your `source` and `fieldName` config and verify the client is sending the token correctly.

### Connections dropping after 2 minutes

Default `idleTimeout` is 120 seconds. Increase it:

```typescript
ws({ port: 3001, idleTimeout: 600 })  // 10 minutes
```

### High memory usage with many rooms

If rooms are created and destroyed rapidly, the C++ room manager cleans up empty rooms automatically. For heavy history usage, reduce `maxEntriesPerRoom`:

```typescript
ws({ port: 3001, history: { maxEntriesPerRoom: 20 } })
```

### Port already in use

cppws owns its port exclusively. Make sure nothing else is running on port 3001 (or whatever port you chose). Your HTTP framework runs on a separate port — they should never share one.

---

**Documentation built by [Ernest Tech House](https://github.com/Ernest12287)**
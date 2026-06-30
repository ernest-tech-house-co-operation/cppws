# Testing — elysiajscppws

> How to run, write, and understand the test suite for elysiajscppws.

---

## Test Runner

We use [Vitest](https://vitest.dev/) — it's fast, ESM-native, and works across Node.js and Bun without configuration changes.

```bash
# Run all tests
npm test

# Run a specific suite
npm run test:unit          # tests/unit/
npm run test:integration   # tests/integration/
npm run test:security      # tests/security/
npm run test:stress        # tests/stress/
```

## Test Structure

```
tests/
├── unit/                          # Pure logic, no native binary needed
│   ├── event-emitter.test.ts      # TypedEmitter class
│   ├── rate-limiter.test.ts       # JSSideRateLimiter + JSSideConnectionThrottler
│   └── room-manager.test.ts       # Room management (against native mock)
├── integration/                   # Tests that exercise the full JS plugin layer
│   ├── plugin.test.ts             # ws() factory + Elysia integration
│   ├── lifecycle.test.ts          # start, stop, graceful shutdown
│   └── sse-fallback.test.ts       # SSE fallback behavior
├── security/                      # Security-focused tests
│   ├── auth.test.ts               # JWT auth, token extraction, cookie parsing
│   ├── rate-limiting.test.ts      # Rate limit enforcement + payload size
│   └── throttling.test.ts         # Per-IP connection throttling
└── stress/                        # Load and stress tests
    ├── connections.test.ts        # High connection counts
    ├── throughput.test.ts         # Messages per second benchmarks
    └── rooms-stress.test.ts       # Many rooms, many members
```

## Unit Tests

Unit tests validate individual components in isolation. They do **not** require the C++ native addon to be compiled — they test against the pure-JS mock or against lightweight test doubles.

### event-emitter.test.ts

**What it covers:**
- Registering and calling listeners with `on()`
- Multiple listeners for the same event
- Multiple event types on the same emitter
- Removing specific listeners with `off()`
- One-time listeners with `once()`
- `emit()` return value (`true` if listeners exist, `false` otherwise)
- `listenerCount()` accuracy
- `eventNames()` listing all active events
- `removeAllListeners()` — both specific event and global clear
- Error resilience — a throwing handler doesn't crash the emitter
- Safe listener removal during iteration (once + throw pattern)

**Why it matters:** The `TypedEmitter` is used by both the public `WebSocketServer` API and the internal `InternalEventBus`. Any bug here affects every event in the system.

### rate-limiter.test.ts

**What it covers:**

**JSSideRateLimiter:**
- Messages within the rate limit are allowed
- Messages exceeding the limit are rejected
- Dropped message count is tracked per connection
- Payloads exceeding `maxPayloadBytes` are rejected (even under the rate limit)
- Connections are tracked independently — one connection hitting its limit doesn't affect others
- Sliding window: messages are allowed again after the time window passes (tested with `vi.useFakeTimers`)
- `removeConnection()` clears all state for a connection
- `getTrackedCount()` reports the number of tracked connections
- `destroy()` cleans up all state and stops the cleanup interval

**JSSideConnectionThrottler:**
- Connections allowed up to the per-IP limit
- Connections rejected beyond the limit
- Different IPs tracked independently
- `remove()` decrements the count, allowing new connections
- `getCount()` reports connections per IP
- `destroy()` clears all state

**Why it matters:** Rate limiting and connection throttling are the primary defense against abuse. The JS layer provides defense-in-depth alongside the C++ native layer.

### room-manager.test.ts

**What it covers:**
- Adding a connection to a room
- A connection joining multiple rooms simultaneously
- Removing a connection from a specific room
- Empty room cleanup when the last connection leaves
- Broadcasting to all connections in a room (verifying non-members don't receive the message)
- Broadcast exclusion after a connection leaves a room
- Multiple independent rooms with overlapping memberships
- Disconnecting a connection removes it from all rooms

**Test approach:** The room manager tests use a lightweight mock of the native module rather than the full C++ addon. This mock implements the same API surface (`joinRoom`, `leaveRoom`, `broadcastToRoom`, `getRoomInfo`, `getConnectionInfo`, `disconnect`) with in-memory Maps and Sets. This validates the JS layer logic without requiring a compiled native binary.

## Integration Tests

Integration tests exercise the full plugin layer — the `ws()` factory, Elysia route registration, connection handling, and the native bridge. These tests may require the C++ addon or the JS mock.

### plugin.test.ts (planned)

Tests the full `ws()` Elysia plugin:
- Plugin returns a valid Elysia plugin function
- `.ws()` route registration works
- The server initializes when Elysia calls `.listen()`
- The server shuts down when Elysia calls `.stop()`
- Multiple `.ws()` routes can coexist

### lifecycle.test.ts (planned)

Tests server lifecycle:
- `initialize()` starts the native server
- Double-initialize is a no-op
- `shutdown()` closes all connections with code 1001
- `shutdown()` is idempotent
- Metrics are preserved after shutdown

### sse-fallback.test.ts (planned)

Tests SSE fallback behavior:
- `shouldUseSSE()` returns `true` when no WebSocket upgrade headers are present
- `shouldUseSSE()` returns `false` for valid WebSocket upgrade requests
- `setupSSEResponse()` sets correct headers
- `sendSSEEvent()` formats data correctly
- Keepalive pings are sent at the configured interval
- Cleanup function stops the keepalive and ends the response

## Security Tests

### auth.test.ts (planned)

Tests the authentication middleware:
- Token extraction from query parameters
- Token extraction from `Authorization: Bearer` header
- Token extraction from cookies (including quoted values)
- Custom `validate` function is called and its return value used
- Built-in JWT verification with correct secret
- JWT expiration check
- JWT signature mismatch rejection
- Missing token returns null (auth fails)
- Auth middleware returns null when auth is disabled

### rate-limiting.test.ts (planned)

End-to-end rate limiting tests:
- Exceeding `maxMessagesPerMinute` causes messages to be dropped
- `rateLimitHit` event is emitted on the internal event bus
- Payload exceeding `maxPayloadBytes` is dropped
- Rate limit resets after the sliding window passes
- Multiple connections have independent rate limits

### throttling.test.ts (planned)

- Per-IP connection limit is enforced
- Connections from different IPs are independent
- Disconnected connections free up the IP slot
- Throttling happens before auth (to prevent token brute-forcing)

## Stress Tests

### connections.test.ts (planned)

- Open 10,000+ connections and verify all are tracked
- Close all connections and verify cleanup
- Memory usage remains stable under high connection churn

### throughput.test.ts (planned)

- Measure messages per second with 1,000 active connections
- Measure messages per second with room broadcasting (1 room, 1000 members)
- Compare native C++ throughput vs pure-JS mock throughput

### rooms-stress.test.ts (planned)

- Create 10,000 rooms
- Join connections to multiple rooms (10 rooms each)
- Broadcast to a room with 5,000 members
- Verify no message loss or duplication

## Writing New Tests

### Test File Naming

- Unit tests: `tests/unit/<feature>.test.ts`
- Integration tests: `tests/integration/<feature>.test.ts`
- Security tests: `tests/security/<feature>.test.ts`
- Stress tests: `tests/stress/<feature>.test.ts`

### Importing the Code Under Test

Since the source is in `src/` and tests are in `tests/`, imports use relative paths:

```typescript
import { TypedEmitter } from '../src/js/event-emitter.js'
import { JSSideRateLimiter } from '../src/js/middleware/rate-limit.js'
```

### Mocking the Native Module

For tests that need the native layer but shouldn't require a compiled binary, create a test mock:

```typescript
function createMockNative() {
  const rooms = new Map<string, Set<string>>()
  const connRooms = new Map<string, Set<string>>()
  const connections = new Map<string, any>()

  return {
    joinRoom(connId: string, room: string) { /* ... */ },
    leaveRoom(connId: string, room: string) { /* ... */ },
    broadcastToRoom(room: string, message: string) { /* ... */ },
    getRoomInfo(room: string) { /* ... */ },
    getConnectionInfo(connId: string) { /* ... */ },
    sendToConnection(connId: string, message: string) { /* ... */ },
    disconnect(connId: string) { /* ... */ },
    configure(opts: Record<string, any>) { /* ... */ },
    getMetrics() { /* ... */ },
    getHistory(room: string, since?: number) { /* ... */ },
    _rooms: rooms,
    _connRooms: connRooms,
    _connections: connections,
  }
}
```

### Vitest API Used

- `describe`, `it`, `expect` — test structure and assertions
- `beforeEach`, `afterEach` — setup and teardown
- `vi.fn()` — spy/mock function creation
- `vi.useFakeTimers()` / `vi.advanceTimersByTime()` — time manipulation
- `vi.useRealTimers()` — restore real timers

## Running Tests in CI

```yaml
# GitHub Actions
- run: npm install
- run: npm run build:ts
- run: npm test
```

The unit tests run without the C++ addon compiled, so they work in any CI environment. Integration and stress tests may require the native addon for full coverage.

---

**Testing documentation by [Ernest Tech House](https://github.com/Ernest12287)**
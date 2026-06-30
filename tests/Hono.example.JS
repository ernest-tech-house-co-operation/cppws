/**
 * cppws + Hono — Integration Example
 *
 * cppws owns WebSockets on port 3001.
 * Hono owns HTTP on port 3000.
 * They never touch each other — clean separation.
 *
 * Run:
 *   npm install cppws hono @hono/node-server
 *   node tests/examples/hono.example.js
 *
 * Test WebSocket:
 *   wscat -c ws://localhost:3001
 *   > { "action": "join", "room": "general" }
 *   > { "action": "broadcast", "room": "general", "text": "hello hono" }
 *
 * Test HTTP:
 *   curl http://localhost:3000/health
 *   curl http://localhost:3000/metrics
 *   curl http://localhost:3000/rooms/general
 */

import { ws } from 'cppws'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'

// ─── cppws WebSocket Server ────────────────────────────────────────────────

const wsServer = ws({
  port: 3001,
  rooms: true,

  security: {
    maxMessagesPerMinute: 120,
    maxPayloadBytes: 1_048_576,   // 1MB
    maxConnectionsPerIP: 10,
  },

  history: { maxEntriesPerRoom: 100 },
  batching: { maxBatchSize: 20, flushInterval: 10 },
})

.onOpen(ctx => {
  console.log(`[cppws] connected: ${ctx.id} (${ctx.ip})`)

  // Auto-join general room
  ctx.join('general')

  ctx.send(JSON.stringify({
    event: 'connected',
    id: ctx.id,
    message: 'Welcome! You are in the general room.',
  }))
})

.onMessage((ctx, data) => {
  // data is already parsed if JSON was sent
  const msg = typeof data === 'object' ? data : {}

  switch (msg.action) {

    case 'join':
      if (!msg.room) return
      ctx.join(msg.room)
      ctx.send(JSON.stringify({ event: 'joined', room: msg.room }))
      ctx.to(msg.room).send(JSON.stringify({
        event: 'user:joined',
        userId: ctx.id,
        room: msg.room,
      }))
      break

    case 'leave':
      if (!msg.room) return
      ctx.leave(msg.room)
      ctx.send(JSON.stringify({ event: 'left', room: msg.room }))
      break

    case 'broadcast':
      if (!msg.room || !msg.text) return
      ctx.to(msg.room).send(JSON.stringify({
        event: 'message',
        from: ctx.id,
        room: msg.room,
        text: msg.text,
        ts: Date.now(),
      }))
      break

    case 'dm':
      if (!msg.userId || !msg.text) return
      ctx.privatelySend(msg.userId, 'dm', {
        from: ctx.id,
        text: msg.text,
      })
      break

    case 'ping':
      ctx.send(JSON.stringify({ event: 'pong', ts: Date.now() }))
      break

    default:
      // Echo anything unknown back to the sender
      ctx.send(JSON.stringify({ event: 'echo', data }))
  }
})

.onClose((ctx, code, reason) => {
  console.log(`[cppws] disconnected: ${ctx.id} (${code} ${reason})`)
})

.start()

console.log('[cppws] WebSocket server running on ws://localhost:3001')

// ─── Hono HTTP Server ──────────────────────────────────────────────────────

const app = new Hono()

// Health check
app.get('/health', (c) => c.json({
  status: 'ok',
  service: 'cppws + hono example',
  wsPort: 3001,
  httpPort: 3000,
}))

// Live WebSocket metrics from the cppws server
app.get('/metrics', (c) => c.json(wsServer.getMetrics()))

// Active connection count
app.get('/connections', (c) => c.json({
  active: wsServer.getConnectionCount(),
}))

// Room info
app.get('/rooms/:room', (c) => {
  const roomName = c.req.param('room')
  try {
    const info = wsServer.getRooms().getRoomInfo(roomName)
    return c.json(info)
  } catch {
    return c.json({ error: `Room '${roomName}' not found` }, 404)
  }
})

// Broadcast history for a room
app.get('/history/:room', (c) => {
  const roomName = c.req.param('room')
  const since    = Number(c.req.query('since') ?? 0)
  const history  = wsServer.getHistory(roomName, since)
  return c.json({ room: roomName, count: history.length, entries: history })
})

// Graceful shutdown
app.get('/shutdown', async (c) => {
  console.log('[hono] graceful shutdown requested')
  setTimeout(async () => {
    await wsServer.shutdown()
    process.exit(0)
  }, 500)
  return c.json({ message: 'shutting down...' })
})

serve({ fetch: app.fetch, port: 3000 }, () => {
  console.log('[hono] HTTP server running on http://localhost:3000')
})

// ─── Process cleanup ────────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n[shutdown] SIGINT received — closing cppws...')
  await wsServer.shutdown()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('\n[shutdown] SIGTERM received — closing cppws...')
  await wsServer.shutdown()
  process.exit(0)
})
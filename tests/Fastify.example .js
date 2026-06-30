/**
 * cppws + Fastify — Integration Example
 *
 * cppws owns WebSockets on port 3001.
 * Fastify owns HTTP on port 3000.
 *
 * Run:
 *   npm install cppws fastify
 *   node tests/examples/fastify.example.js
 *
 * Test WebSocket:
 *   wscat -c ws://localhost:3001
 *   > { "action": "join", "room": "general" }
 *   > { "action": "broadcast", "room": "general", "text": "hello fastify" }
 *
 * Test HTTP:
 *   curl http://localhost:3000/health
 *   curl http://localhost:3000/metrics
 *   curl http://localhost:3000/rooms/general
 */

import { ws } from 'cppws'
import Fastify from 'fastify'

// ─── cppws WebSocket Server ────────────────────────────────────────────────

const wsServer = ws({
  port: 3001,
  rooms: true,

  security: {
    maxMessagesPerMinute: 120,
    maxPayloadBytes: 1_048_576,
    maxConnectionsPerIP: 10,
  },

  history: { maxEntriesPerRoom: 100 },
  batching: { maxBatchSize: 20, flushInterval: 10 },
  idleTimeout: 120,
})

.onOpen(ctx => {
  console.log(`[cppws] connected: ${ctx.id} (${ctx.ip})`)

  ctx.join('general')

  ctx.send(JSON.stringify({
    event: 'connected',
    id: ctx.id,
    message: 'Welcome! You are in the general room.',
  }))
})

.onMessage((ctx, data) => {
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

    case 'rooms':
      // Return the list of rooms the caller is in
      ctx.send(JSON.stringify({
        event: 'rooms',
        rooms: [...ctx.rooms],
      }))
      break

    case 'ping':
      ctx.send(JSON.stringify({ event: 'pong', ts: Date.now() }))
      break

    default:
      ctx.send(JSON.stringify({ event: 'echo', data }))
  }
})

.onClose((ctx, code, reason) => {
  console.log(`[cppws] disconnected: ${ctx.id} (${code} ${reason})`)
})

.start()

console.log('[cppws] WebSocket server running on ws://localhost:3001')

// ─── Fastify HTTP Server ───────────────────────────────────────────────────

const fastify = Fastify({ logger: false })

// Health check
fastify.get('/health', async () => ({
  status: 'ok',
  service: 'cppws + fastify example',
  wsPort: 3001,
  httpPort: 3000,
}))

// Live metrics
fastify.get('/metrics', async () => wsServer.getMetrics())

// Active connections
fastify.get('/connections', async () => ({
  active: wsServer.getConnectionCount(),
}))

// Room info
fastify.get('/rooms/:room', async (req, reply) => {
  const { room } = req.params
  try {
    return wsServer.getRooms().getRoomInfo(room)
  } catch {
    return reply.status(404).send({ error: `Room '${room}' not found` })
  }
})

// Message history
fastify.get('/history/:room', async (req) => {
  const { room } = req.params
  const since    = Number(req.query.since ?? 0)
  const history  = wsServer.getHistory(room, since)
  return { room, count: history.length, entries: history }
})

// Graceful shutdown endpoint
fastify.get('/shutdown', async (req, reply) => {
  reply.send({ message: 'shutting down...' })
  setTimeout(async () => {
    await wsServer.shutdown()
    await fastify.close()
    process.exit(0)
  }, 500)
})

// Boot Fastify
fastify.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error('[fastify] failed to start:', err)
    process.exit(1)
  }
  console.log('[fastify] HTTP server running on http://localhost:3000')
})

// ─── Process cleanup ────────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n[shutdown] SIGINT — closing servers...')
  await wsServer.shutdown()
  await fastify.close()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('\n[shutdown] SIGTERM — closing servers...')
  await wsServer.shutdown()
  await fastify.close()
  process.exit(0)
})
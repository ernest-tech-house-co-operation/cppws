# cppws in Build Pipelines — What You Need to Know

> **If you're here because your Next.js / Vercel / AWS Amplify / Docker build just exploded
> with a native addon error — this document is for you.**

---

## We Carry Sharp's Most Famous Curse

cppws uses the same binary distribution model as [Sharp](https://github.com/lovell/sharp).
Sharp is the gold standard for native Node.js image processing. It's fast, reliable, and used
in production everywhere. It's also responsible for one of the most Googled errors in the
entire JavaScript ecosystem:

```
Error: Cannot find module '@cppws/linux-x64-gnu'
```
```
Error: The module was compiled against a different Node.js version
```
```
Could not load the "sharp" module using the darwin-arm64 runtime
```

Sound familiar? That's the Sharp problem. **cppws has the same one** — and we're not going
to pretend otherwise.

---

## Why This Happens

When you `npm install cppws` on your MacBook, npm downloads the pre-built binary for
`darwin-arm64` (or `darwin-x64`). That binary is a compiled C++ shared library. It works
perfectly on your machine.

Then you push to production. Your build pipeline — Vercel, AWS Amplify, Railway, Render,
a Docker container — runs on Linux x64. It tries to load the `darwin-arm64` binary.
Linux cannot execute a macOS binary. The whole thing collapses.

What makes it worse is *when* it collapses. Next.js (and similar frameworks) don't just
run your server code at request time — they execute it **during the build** to generate
static pages, run `getStaticProps`, analyse your imports, and tree-shake your bundle.
The moment Next.js touches any file that imports `cppws`, it tries to load the native
addon. Wrong platform. Build fails. Deploy fails. You're debugging a CI log at midnight.

This is not a cppws bug. It's not a Next.js bug. It's the fundamental reality of native
addons in JavaScript build pipelines, and Sharp has been fighting this battle for years.

---

## The Scenarios Where This Bites You

### ❌ Scenario 1 — Importing cppws inside a Next.js API route

```typescript
// pages/api/socket.ts  ← DO NOT DO THIS
import { ws } from 'cppws'

export default function handler(req, res) {
  // ...
}
```

Next.js will try to bundle and execute this file during `next build`. It will hit the
native addon. If the binary doesn't match the build environment, the build dies.

Even if the binary *does* match, this is the wrong pattern entirely — see below.

---

### ❌ Scenario 2 — Running cppws inside a serverless function

```typescript
// Vercel serverless function
import { ws } from 'cppws'

export default async function handler(req, res) {
  const server = ws({ port: 3001 }).start()  // ← this makes no sense serverlessly
}
```

Serverless functions are stateless and short-lived. A WebSocket server that owns a port
and maintains persistent connections cannot live inside a serverless function. Full stop.
This isn't a platform limitation — it's a category mismatch.

---

### ❌ Scenario 3 — Deploying cppws on Vercel / Netlify / similar

Vercel and Netlify are serverless platforms. They don't support long-running processes,
persistent ports, or stateful WebSocket servers. cppws is all three of those things.
Deploying it there will not work regardless of the binary situation.

---

### ✅ Scenario 4 — The correct pattern

cppws is a **standalone server**. It was designed to run alongside your HTTP framework,
not inside it. The correct deployment architecture is:

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│       Next.js App           │     │        cppws Server          │
│   (Vercel / any platform)   │     │   (VPS / ECS / Railway etc.) │
│                             │     │                              │
│  pages/                     │     │  ws({ port: 3001 })          │
│  api/                       │     │    .onOpen(ctx => ...)       │
│  components/                │ WS  │    .onMessage(...)           │
│                             │◄───►│    .start()                  │
│  // client connects to      │     │                              │
│  // ws://your-cppws-server  │     │                              │
└─────────────────────────────┘     └──────────────────────────────┘
```

Your Next.js app never imports cppws. It never touches the binary. The browser client
connects directly to the cppws server via WebSocket. Next.js just serves the frontend.

---

## The Fix For Each Platform

### Vercel

Don't run cppws on Vercel. Deploy it separately (see options below) and connect via
WebSocket from your frontend. Vercel is for your Next.js app. cppws needs its own home.

### AWS Amplify

Same story. Amplify is for your frontend/API. Deploy cppws on an EC2 instance, ECS
container, or App Runner service in the same AWS region. Connect via WebSocket.

If you absolutely must have cppws on the same build pipeline (e.g. a monorepo where
the import leaks into the build), add it to `serverExternalPackages` in your
Next.js config so the bundler never touches it:

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['cppws'],
}

module.exports = nextConfig
```

This tells Next.js: *don't try to bundle this package, leave it as a runtime require.*
It prevents the build-time native addon load. But this only helps if cppws is running
in a long-lived Node.js server environment (`next start`), not serverless.

### Docker

This is where the platform mismatch most commonly bites people. You developed on macOS,
your Docker image is Linux. The `darwin-arm64` binary won't load.

Fix it by making sure npm installs inside the Docker image, not outside it:

```dockerfile
FROM node:20-bookworm-slim

WORKDIR /app

# Copy package files FIRST
COPY package*.json ./

# npm install runs INSIDE the container → downloads linux-x64-gnu binary
RUN npm install

COPY . .
RUN npm run build   # Next.js build — cppws is external, won't be bundled

CMD ["node", "server.js"]  # your cppws standalone server
```

**The most common Docker mistake:** copying your local `node_modules` into the container
with `COPY . .` before running `npm install`. This brings your macOS binaries into a
Linux container. Always `npm install` inside the container.

Add this to your `.dockerignore`:

```
node_modules
.next
```

### Railway / Render / Fly.io

These platforms build and run your container on Linux x64. As long as you let the
platform run `npm install` (which they all do by default), the correct Linux binary
will be downloaded automatically. No special config needed.

Just make sure cppws is in `dependencies`, not `devDependencies`:

```json
{
  "dependencies": {
    "cppws": "^1.0.0"
  }
}
```

Platforms skip `devDependencies` in production installs. If cppws is in `devDependencies`
it won't be there at runtime.

### Turborepo / Nx Monorepos

If cppws lives in a shared package inside a monorepo and gets imported by your Next.js
app (even transitively), the bundler will find it. Add it to `serverExternalPackages`
in your Next.js config as shown above, and make sure the workspace that actually *runs*
cppws is a separate long-running service, not a Next.js app.

---

## Why `serverExternalPackages` Is Not a Silver Bullet

`serverExternalPackages` (formerly `experimental.serverComponentsExternalPackages`) tells
the Next.js bundler to leave a package as a native `require()` call rather than bundling
it. This fixes the build-time crash. But it doesn't fix the runtime problem.

If you're on Vercel or any serverless platform, `require('cppws')` will still be called
when a request comes in. It will still try to start a WebSocket server on a port. That
port doesn't exist in a serverless function. The connection will never be reachable.
`serverExternalPackages` just moves the failure from build time to runtime.

The real fix is separation. cppws as its own service. Next.js as its own service.
They talk over the network. Neither one knows how the other is implemented.

---

## The Correct Deployment Architecture

```
Browser
  │
  ├──── HTTPS ────► Vercel / Netlify / Amplify
  │                  (Next.js — pages, API routes, SSR)
  │
  └──── WSS ──────► Your cppws Server
                     (VPS / ECS / Railway / Fly.io / Render)
                     Port 3001, always-on, stateful
```

```typescript
// Your Next.js frontend — no cppws import anywhere
'use client'

export default function ChatPage() {
  useEffect(() => {
    // Connect directly to your cppws server
    const socket = new WebSocket('wss://ws.yourapp.com')

    socket.onmessage = (e) => {
      const data = JSON.parse(e.data)
      // handle it
    }

    return () => socket.close()
  }, [])
}
```

```typescript
// Your cppws server — completely separate deployment
// server.ts (runs on Railway, Fly.io, EC2, wherever)
import { ws } from 'cppws'

ws({ port: 3001, rooms: true })
  .onOpen(ctx => ctx.join('general'))
  .onMessage((ctx, data) => ctx.to('general').send(data))
  .start()
```

Two repos, or two services in a monorepo. Deployed independently. The browser connects
to both. Next.js never sees cppws. cppws never sees Next.js. Everyone is happy.

---

## Quick Reference

| Situation | Fix |
|-----------|-----|
| `cannot find module '@cppws/linux-x64-gnu'` | Let `npm install` run inside your Linux container, don't copy `node_modules` from macOS |
| Next.js build crashes on import | Add `cppws` to `serverExternalPackages` in `next.config.js` |
| Vercel/Netlify deploy failing | Don't run cppws there — deploy it as a separate service |
| Binary loads but port unreachable | You're in a serverless function — cppws needs a long-running process |
| Works locally, fails in CI | Your CI is a different OS/arch — let CI run `npm install` fresh |
| Monorepo import leaking | Add `serverExternalPackages` and isolate cppws into its own service package |

---

## The Honest Summary

cppws is a long-running, stateful, port-owning WebSocket server built on native C++.
It is not a library you import into a Next.js page. It is not a Vercel function.
It is not something that gets bundled.

It's a server. Deploy it like one.

The Sharp comparison holds perfectly here: you wouldn't run Sharp's image processing
pipeline inside a serverless function on every request either. You'd run it as a
separate service, or offload it to a queue. Same idea.

We carry Sharp's curse because we made the same architectural bet Sharp made — native
performance over deployment simplicity. For the right use case, it's absolutely worth it.
Just deploy cppws where it belongs: on a machine that stays running.

---

**Built by [Ernest Tech House](https://github.com/Ernest12287)**
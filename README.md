# cppws (elysiajscppws)

The fastest WebSocket library alive. Runtime-agnostic, high-performance WebSocket
server powered by C++ (uWebSockets). Bring your framework — cppws runs alongside it.

- Native C++ core (uWebSockets + uSockets) exposed to Node/Bun via N-API
- Rooms, broadcast, message history/replay, rate limiting, connection throttling, live metrics
- Runtime-agnostic JS layer — works standalone or bolted onto Elysia/Express/etc.

## Status

One process = one running server instance (singleton native core). This is
intentional, not a bug — see [Multi-instance](#multi-instance) below. Current
test status: **89 passed / 2 skipped / 0 failed**. Full breakdown in
[TESTS_FINAL.md](./TESTS_FINAL.md).

## Install

```bash
npm install cppws
```

If a pre-built binary exists for your platform, that's used automatically.
Otherwise cppws falls back to a pure-JS mock at runtime — for full native
performance, build from source (see below).

## Quick Start

```ts
import { ws } from 'cppws'

const server = ws({
  port: 7331,
  idleTimeout: 120,
  maxPayload: 1_048_576,
})

server.on('message', (connectionId, room, text) => {
  server.broadcastToRoom(room, text)
})

server.start()
```

## Building from Source

You need `cmake`, a C++17 compiler, and `libuv`. Full details, platform notes,
and troubleshooting live in [Build.md](./Build.md). Quick path:

```bash
# Linux
./scripts/build-linux.sh

# macOS
./scripts/build-macos.sh

# Windows (PowerShell)
./scripts/build-windows.ps1
```

Each script clones `uWebSockets` into `deps/`, builds `uSockets.a`, then runs
`npm run build:cpp` to compile the native addon into `build/Release/`.

## Testing

```bash
npm test                    # unit tests (vitest)
npx tsx tests/integration/testmain.ts   # full integration suite
```

See [TESTS.md](./TESTS.md) for suite structure and [TESTS_FINAL.md](./TESTS_FINAL.md)
for the current pass/fail state and why the one remaining failure is expected.

## Prebuilt Binaries

Each platform's compiled `.node` binary is published as its own tiny npm
package under the `@cppws` scope (`@cppws/linux-x64-gnu`,
`@cppws/darwin-arm64`, etc.) and listed as an `optionalDependency` of the
main `cppws` package. npm installs only the one matching your OS/arch and
silently skips the rest — same model as [Sharp](https://github.com/lovell/sharp).

Publishing under `@cppws/*` requires owning that scope on npm — either an
npm org named `cppws`, or a personal account with that exact username.
`scripts/prebuild.js` and `package.json`'s `optionalDependencies` must
always reference the same scope; a mismatch here means `npm install`
silently fails to fetch the right binary.

## Multi-instance

The native core is a process-wide singleton — one listening port per process.
This is by design: a single instance already handles unlimited concurrent
client connections, rooms, and broadcasts. If you need two independent WS
endpoints, run two Node processes rather than two instances in one process.

## Branching & Releases

| Branch      | Trigger              | Result                                   |
|-------------|----------------------|-------------------------------------------|
| `master`    | PR merge / push      | Official release, published to npm         |
| `beta`      | push                 | Prerelease / beta build (`x.y.z-beta.N`)   |
| `testbuild` | push                 | Cross-platform build matrix, catches build errors — no publish |
| `main`      | —                    | Idle. Not wired to CI.                     |

`testbuild`'s matrix covers `ubuntu-latest`, `ubuntu-22.04`, `macos-latest`
(arm64), and `windows-latest` — `macos-13` (x64) was dropped after its
runner queue hung indefinitely; GitHub has been retiring that label. Each
matrix job zips its `build/Release/` output and uploads it as an
`testbuild-<target>.zip` workflow artifact, so a build can be pulled down
and inspected without re-running the job.

See workflow files under `.github/workflows/` for the exact CI behavior of
each branch.

## Docs Index

- [Build.md](./Build.md) — native addon build pipeline, platform binary pitfalls
- [TESTS.md](./TESTS.md) — how to run and write tests
- [TESTS_FINAL.md](./TESTS_FINAL.md) — current suite result and known-issue writeup
- [DOCS.md](./DOCS.md) — API reference

## License

MIT
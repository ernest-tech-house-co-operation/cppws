// postinstall.js — runs after `npm install`
//
// Currently this is a no-op. When pre-built binaries are published to the
// `@elysiajscppws/<platform-arch>` optional dependency packages, this
// script will verify the correct binary is present in `prebuilds/`.
//
// If no binary is found the plugin falls back to a pure-JS mock at
// runtime (see src/js/native-loader.ts), so a missing binary is not
// fatal — it just means degraded performance.

'use strict'

const fs = require('fs')
const path = require('path')
const { platform, arch } = process

function detectLibc() {
  if (platform !== 'linux') return null
  try {
    const report = fs.readFileSync('/usr/bin/ldd', 'utf8')
    return report.includes('musl') ? 'musl' : 'gnu'
  } catch {
    return null
  }
}

function getPlatformArch() {
  const libc = detectLibc()
  if (platform === 'win32') return `${platform}-${arch}-msvc`
  if (libc) return `${platform}-${arch}-${libc}`
  return `${platform}-${arch}`
}

function main() {
  const platformArch = getPlatformArch()
  const prebuildDir = path.join(__dirname, '..', 'prebuilds', platformArch)
  const binaryPath = path.join(prebuildDir, 'elysiajscppws_native.node')

  if (fs.existsSync(binaryPath)) {
    console.log(`[elysiajscppws] Pre-built binary found for ${platformArch}`)
  } else {
    // Not an error — the native-loader will fall back to the JS mock.
    // The user can compile from source with: npm run build:cpp
    console.log(
      `[elysiajscppws] No pre-built binary for ${platformArch}. ` +
      `The plugin will use a pure-JS fallback at runtime. ` +
      `Run "npm run build:cpp" to compile from source.`
    )
  }
}

main()
// scripts/platform.js — single source of truth for platform-arch target
// naming. Both postinstall.js (runtime, on the consumer's machine) and
// prebuild.js (build time, in CI) import this so the tag they compute can
// never drift apart. If it ever does, the download 404s loudly instead of
// silently mismatching.

'use strict'

const fs = require('fs')

// The exact set of targets release.yml / beta.yml build in CI.
// Add a target here *and* to the CI matrix at the same time.
const SUPPORTED_TARGETS = [
  'linux-x64-gnu',
  'darwin-arm64',
  'win32-x64-msvc',
]

function detectLibc() {
  if (process.platform !== 'linux') return null
  try {
    const report = fs.readFileSync('/usr/bin/ldd', 'utf8')
    return report.includes('musl') ? 'musl' : 'gnu'
  } catch {
    return 'gnu' // best-effort default; most CI/dev linux boxes are glibc
  }
}

function getPlatformArch() {
  const { platform, arch } = process
  if (platform === 'win32') return `${platform}-${arch}-msvc`
  if (platform === 'linux') return `${platform}-${arch}-${detectLibc()}`
  return `${platform}-${arch}`
}

function isSupportedTarget(target) {
  return SUPPORTED_TARGETS.includes(target)
}

module.exports = { SUPPORTED_TARGETS, getPlatformArch, isSupportedTarget }

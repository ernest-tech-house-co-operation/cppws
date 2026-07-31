#!/usr/bin/env node
// prebuild.js — compile the native C++ addon and stage it as a pre-built binary
//
// Usage:
//   node scripts/prebuild.js              # build for current platform
//   node scripts/prebuild.js --pack       # also create the tarball CI uploads to the GitHub Release
//
// Output:
//   prebuilds/<platform-arch>/cppws_native.node
//   prebuilds/<platform-arch>/cppws-native-<platform-arch>.tar.gz   (with --pack)
//
// The tarball name/contents must match what scripts/postinstall.js downloads
// and extracts — see SUPPORTED_TARGETS in scripts/platform.js.

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { platform } = process
const { getPlatformArch, SUPPORTED_TARGETS } = require('./platform.js')

function buildRelease() {
  console.log('[prebuild] Compiling C++ addon in Release mode...')
  execSync('npx cmake-js build --release', {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  })
  console.log('[prebuild] Compilation complete.')
}

function findCompiledBinary() {
  const candidates = [
    path.resolve(__dirname, '..', 'build', 'Release', 'cppws_native.node'),
    path.resolve(__dirname, '..', 'build', 'Debug', 'cppws_native.node'),
    // Ninja (single-config generator) writes directly to build/, not
    // build/Release or build/Debug -- this is used on macOS runners
    // where ninja is auto-selected by cmake-js when available.
    path.resolve(__dirname, '..', 'build', 'cppws_native.node'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function stageBinary(platformArch) {
  const src = findCompiledBinary()
  if (!src) {
    console.error('[prebuild] ERROR: Compiled cppws_native.node not found in build/Release, build/Debug, or build/.')
    console.error('[prebuild] Make sure cmake-js completed successfully.')
    process.exit(1)
  }

  const destDir = path.resolve(__dirname, '..', 'prebuilds', platformArch)
  const dest = path.join(destDir, 'cppws_native.node')

  fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(src, dest)

  const stats = fs.statSync(dest)
  const kb = (stats.size / 1024).toFixed(1)
  console.log(`[prebuild] Staged ${platformArch}/cppws_native.node (${kb} KB)`)
}

function packTarball(platformArch) {
  const destDir = path.resolve(__dirname, '..', 'prebuilds', platformArch)
  // Filename must match what postinstall.js requests from the GitHub Release.
  const tarball = path.join(destDir, `cppws-native-${platformArch}.tar.gz`)

  if (platform === 'win32') {
    // bsdtar ships with Windows 10 1803+ / Server 2019+, same as CI runners.
    execSync(`tar -czf "${tarball}" -C "${destDir}" cppws_native.node`, { stdio: 'inherit' })
  } else {
    execSync(`tar -czf "${tarball}" -C "${destDir}" cppws_native.node`, { stdio: 'inherit' })
  }
  const stats = fs.statSync(tarball)
  const kb = (stats.size / 1024).toFixed(1)
  console.log(`[prebuild] Created ${tarball} (${kb} KB)`)
}

function main() {
  const args = process.argv.slice(2)
  const doPack = args.includes('--pack')

  const platformArch = getPlatformArch()
  console.log(`[prebuild] Platform: ${platformArch}`)
  console.log(`[prebuild] Node: ${process.version}`)
  if (!SUPPORTED_TARGETS.includes(platformArch)) {
    console.log(
      `[prebuild] NOTE: "${platformArch}" is not in SUPPORTED_TARGETS (scripts/platform.js).\n` +
        `[prebuild] The binary will build fine locally, but postinstall.js won't know to fetch it\n` +
        `[prebuild] for this target until it's added there and to the CI matrix.`
    )
  }
  console.log()

  buildRelease()
  stageBinary(platformArch)
  if (doPack) packTarball(platformArch)

  console.log()
  console.log('[prebuild] Done. Binary is at:')
  console.log(`  prebuilds/${platformArch}/cppws_native.node`)
  if (doPack) {
    console.log('[prebuild] Tarball ready for GitHub Release upload:')
    console.log(`  prebuilds/${platformArch}/cppws-native-${platformArch}.tar.gz`)
  }
}

main()

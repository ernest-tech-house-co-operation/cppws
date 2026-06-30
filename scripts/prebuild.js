#!/usr/bin/env node
// prebuild.js — compile the native C++ addon and stage it as a pre-built binary
//
// Usage:
//   node scripts/prebuild.js              # build for current platform
//   node scripts/prebuild.js --pack       # also create a publishable tarball
//   node scripts/prebuild.js --all        # (CI) build for all 8 platform targets
//
// The compiled .node file is placed in:
//   prebuilds/<platform-arch>/elysiajscppws_native.node
//
// When --pack is used, a tarball is created at:
//   prebuilds/<platform-arch>/elysiajscppws_native.tar.gz

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { platform, arch } = process

// ── Platform detection ──────────────────────────────────────────────────

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

// ── All supported targets (for CI matrix builds) ────────────────────────

const ALL_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64-gnu',
  'linux-x64-musl',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'win32-x64-msvc',
  'win32-arm64-msvc',
]

// ── Build ──────────────────────────────────────────────────────────────

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
    path.resolve(__dirname, '..', 'build', 'Release', 'elysiajscppws_native.node'),
    path.resolve(__dirname, '..', 'build', 'Debug', 'elysiajscppws_native.node'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function stageBinary(platformArch) {
  const src = findCompiledBinary()
  if (!src) {
    console.error('[prebuild] ERROR: Compiled .node file not found in build/Release or build/Debug.')
    console.error('[prebuild] Make sure cmake-js completed successfully.')
    process.exit(1)
  }

  const destDir = path.resolve(__dirname, '..', 'prebuilds', platformArch)
  const dest = path.join(destDir, 'elysiajscppws_native.node')

  fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(src, dest)

  const stats = fs.statSync(dest)
  const kb = (stats.size / 1024).toFixed(1)
  console.log(`[prebuild] Staged ${platformArch}/elysiajscppws_native.node (${kb} KB)`)
}

function createPackageJson(platformArch) {
  const destDir = path.resolve(__dirname, '..', 'prebuilds', platformArch)
  const pkg = {
    name: `@elysiajscppws/${platformArch}`,
    version: require(path.resolve(__dirname, '..', 'package.json')).version,
    description: 'Pre-built native binary for elysiajscppws',
    os: [extractOS(platformArch)],
    cpu: [extractArch(platformArch)],
    files: ['elysiajscppws_native.node'],
    repository: {
      type: 'git',
      url: 'https://github.com/Ernest12287/elysiajscppws.git',
      directory: `prebuilds/${platformArch}`,
    },
    license: 'MIT',
  }
  fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  console.log(`[prebuild] Created package.json for @elysiajscppws/${platformArch}`)
}

function extractOS(platformArch) {
  if (platformArch.startsWith('win32')) return 'win32'
  if (platformArch.startsWith('darwin')) return 'darwin'
  return 'linux'
}

function extractArch(platformArch) {
  // e.g. "linux-x64-gnu" → "x64", "win32-arm64-msvc" → "arm64"
  const parts = platformArch.split('-')
  return parts[1]
}

function packTarball(platformArch) {
  const destDir = path.resolve(__dirname, '..', 'prebuilds', platformArch)
  const tarball = path.join(destDir, 'elysiajscppws_native.tar.gz')

  // Use tar if available (Linux/macOS), skip on Windows (user can zip manually)
  if (platform === 'win32') {
    console.log(`[prebuild] Skipping tarball creation on Windows.`)
    console.log(`[prebuild] Manually zip: ${destDir}/`)
    return
  }

  console.log(`[prebuild] Creating tarball...`)
  execSync(`tar -czf ${tarball} -C ${destDir} elysiajscppws_native.node package.json`, {
    stdio: 'inherit',
  })
  const stats = fs.statSync(tarball)
  const kb = (stats.size / 1024).toFixed(1)
  console.log(`[prebuild] Created ${tarball} (${kb} KB)`)
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const doPack = args.includes('--pack')
  const doAll = args.includes('--all')

  if (doAll) {
    console.log('[prebuild] ═══════════════════════════════════════════')
    console.log('[prebuild]  Cross-compilation for all targets is not')
    console.log('[prebuild]  supported by this script. Use a CI matrix')
    console.log('[prebuild]  (GitHub Actions) where each job runs on')
    console.log('[prebuild]  the actual target OS/arch and calls:')
    console.log('[prebuild]    node scripts/prebuild.js [--pack]')
    console.log('[prebuild] ═══════════════════════════════════════════')
    console.log()
    console.log('Targets to cover in CI:')
    for (const t of ALL_TARGETS) {
      console.log(`  - ${t}`)
    }
    console.log()
    console.log('Example GitHub Actions step:')
    console.log(`
  - name: Prebuild native addon
    run: node scripts/prebuild.js --pack
  - name: Upload artifact
    uses: actions/upload-artifact@v4
    with:
      name: prebuild-\${{ matrix.platform }}
      path: prebuilds/
`)
    process.exit(0)
  }

  const platformArch = getPlatformArch()
  console.log(`[prebuild] Platform: ${platformArch}`)
  console.log(`[prebuild] Node: ${process.version}`)
  console.log()

  // 1. Compile
  buildRelease()

  // 2. Stage into prebuilds/<platform-arch>/
  stageBinary(platformArch)

  // 3. Create a minimal package.json for the platform package
  createPackageJson(platformArch)

  // 4. Optionally create a tarball
  if (doPack) {
    packTarball(platformArch)
  }

  console.log()
  console.log('[prebuild] Done. Binary is at:')
  console.log(`  prebuilds/${platformArch}/elysiajscppws_native.node`)
  console.log()
  console.log('[prebuild] To publish this platform package:')
  console.log(`  cd prebuilds/${platformArch} && npm publish --access public`)
}

main()
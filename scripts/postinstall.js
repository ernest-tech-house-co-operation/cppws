// postinstall.js — runs after `npm install cppws`
//
// The npm package only ships JS. The compiled native addon lives on
// GitHub Releases, tagged to match this package's own version (the
// ONE version number in this whole project — see package.json). This
// script downloads it and stages it at:
//
//   prebuilds/<platform-arch>/cppws_native.node
//
// where native-loader.ts expects to find it at runtime.
//
// There is no JS fallback anymore. If the download fails, install fails
// loudly — that's on purpose, so a broken environment is caught here
// instead of surfacing as a confusing runtime error later.
//
// Escape hatches:
//   CPPWS_SKIP_DOWNLOAD=1   skip entirely (e.g. you're about to `npm run build:cpp` from source)
//   CPPWS_BASE_URL=<url>    point at a mirror / private release host instead of GitHub

'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const { execFileSync } = require('child_process')
const { getPlatformArch, isSupportedTarget } = require('./platform.js')

const REPO = 'ernest-tech-house-co-operation/cppws'
const BASE_URL = process.env.CPPWS_BASE_URL || `https://github.com/${REPO}/releases/download`

// The package's own version is the ONLY version that matters here.
// No package-lock.json needed: package.json ships inside the installed
// package itself (it's right next to this script), so it's always
// available and always correct for what was actually published —
// unlike package-lock.json, which describes the *consumer's* project,
// not this package.
const VERSION = require('../package.json').version

function downloadUrl(target) {
  return `${BASE_URL}/v${VERSION}/cppws-native-${target}.tar.gz`
}

function fetchFile(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'cppws-postinstall' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
          res.resume()
          return resolve(fetchFile(res.headers.location, dest, redirectsLeft - 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        }
        const file = fs.createWriteStream(dest)
        res.pipe(file)
        file.on('finish', () => file.close(resolve))
        file.on('error', reject)
      })
      .on('error', reject)
  })
}

function extractTarball(tarballPath, destDir) {
  // `tar` ships with modern Linux, macOS, and Windows (bsdtar since
  // Win10 1803), so shelling out avoids pulling in a JS tar dependency.
  execFileSync('tar', ['-xzf', tarballPath, '-C', destDir], { stdio: 'inherit' })
}

async function main() {
  if (process.env.CPPWS_SKIP_DOWNLOAD === '1') {
    console.log('[cppws] CPPWS_SKIP_DOWNLOAD=1 set — skipping binary download.')
    return
  }

  const target = getPlatformArch()

  if (!isSupportedTarget(target)) {
    console.error(
      `[cppws] No prebuilt binary is published for "${target}".\n` +
        `[cppws] Supported targets: linux-x64-gnu, darwin-arm64, win32-x64-msvc.\n` +
        `[cppws] Build from source instead: npm run build:cpp\n` +
        `[cppws] (Or set CPPWS_SKIP_DOWNLOAD=1 to install without a binary.)`
    )
    process.exit(1)
  }

  const destDir = path.join(__dirname, '..', 'prebuilds', target)
  const binaryPath = path.join(destDir, 'cppws_native.node')

  if (fs.existsSync(binaryPath)) {
    console.log(`[cppws] Binary already present for ${target}, skipping download.`)
    return
  }

  fs.mkdirSync(destDir, { recursive: true })
  const url = downloadUrl(target)
  const tmpTarball = path.join(destDir, '.cppws_native.tar.gz.tmp')

  console.log(`[cppws] Fetching v${VERSION} binary for ${target}...`)
  console.log(`[cppws]   ${url}`)

  try {
    await fetchFile(url, tmpTarball)
    extractTarball(tmpTarball, destDir)
    fs.unlinkSync(tmpTarball)

    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Tarball extracted but ${binaryPath} was not found inside it.`)
    }

    console.log(`[cppws] Installed native binary → prebuilds/${target}/cppws_native.node`)
  } catch (err) {
    if (fs.existsSync(tmpTarball)) fs.unlinkSync(tmpTarball)
    console.error(`[cppws] Failed to download native binary: ${err.message}`)
    console.error(
      `[cppws] Check that release v${VERSION} exists at:\n` +
        `[cppws]   https://github.com/${REPO}/releases/tag/v${VERSION}\n` +
        `[cppws] Or build from source: npm run build:cpp\n` +
        `[cppws] (Or set CPPWS_SKIP_DOWNLOAD=1 and build later.)`
    )
    process.exit(1)
  }
}

main()

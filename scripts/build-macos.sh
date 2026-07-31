#!/usr/bin/env bash
# build-macos.sh — build the cppws native addon on macOS
#
# Usage:
#   ./scripts/build-macos.sh [--release]
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RELEASE_FLAG=""
if [[ "${1:-}" == "--release" ]]; then
  RELEASE_FLAG="--release"
fi

echo "[build-macos] Checking system dependencies..."

if ! xcode-select -p >/dev/null 2>&1; then
  echo "[build-macos] Xcode Command Line Tools not found. Run: xcode-select --install"
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "[build-macos] cmake not found."
  if command -v brew >/dev/null 2>&1; then
    echo "[build-macos] Installing via Homebrew..."
    brew install cmake
  else
    echo "[build-macos] Install Homebrew first (https://brew.sh), then: brew install cmake"
    exit 1
  fi
fi

if ! brew list libuv >/dev/null 2>&1; then
  echo "[build-macos] libuv not found. Installing via Homebrew..."
  brew install libuv
fi

echo "[build-macos] Fetching uWebSockets (if missing)..."
if [ ! -d "deps/uWebSockets" ]; then
  git clone --recurse-submodules --depth 1 --branch v20.67.0 \
    https://github.com/uNetworking/uWebSockets.git deps/uWebSockets
else
  echo "[build-macos] deps/uWebSockets already present, skipping clone."
fi

echo "[build-macos] Building uSockets.a..."
make -C deps/uWebSockets/uSockets

echo "[build-macos] Installing npm dependencies..."
npm install

echo "[build-macos] Compiling native addon..."
npm run build:cpp -- $RELEASE_FLAG

echo "[build-macos] Staging binary into build/Release/..."
mkdir -p build/Release
if [ -f build/cppws_native.node ]; then
  cp build/cppws_native.node build/Release/
fi

echo "[build-macos] Done. Binary at build/Release/cppws_native.node"

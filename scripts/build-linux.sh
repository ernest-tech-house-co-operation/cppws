#!/usr/bin/env bash
# build-linux.sh — build the cppws native addon on Linux
#
# Usage:
#   ./scripts/build-linux.sh [--release]
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RELEASE_FLAG=""
if [[ "${1:-}" == "--release" ]]; then
  RELEASE_FLAG="--release"
fi

echo "[build-linux] Checking system dependencies..."
command -v cmake >/dev/null 2>&1 || { echo "cmake not found. Install with: sudo apt-get install -y cmake"; exit 1; }
command -v g++   >/dev/null 2>&1 || { echo "g++ not found. Install with: sudo apt-get install -y build-essential"; exit 1; }

if ! ldconfig -p | grep -q libuv; then
  echo "[build-linux] libuv not found. Install with: sudo apt-get install -y libuv1-dev"
  exit 1
fi

echo "[build-linux] Fetching uWebSockets (if missing)..."
if [ ! -d "deps/uWebSockets" ]; then
  git clone --recurse-submodules --depth 1 --branch v20.67.0 \
    https://github.com/uNetworking/uWebSockets.git deps/uWebSockets
else
  echo "[build-linux] deps/uWebSockets already present, skipping clone."
fi

echo "[build-linux] Building uSockets.a..."
make -C deps/uWebSockets/uSockets

echo "[build-linux] Installing npm dependencies..."
# CPPWS_SKIP_DOWNLOAD: this script's whole job is to compile the binary
# from source, so postinstall.js has nothing to download yet (the release
# for this version may not even exist). Without this, npm install fails
# the entire build on a 404.
CPPWS_SKIP_DOWNLOAD=1 npm install

echo "[build-linux] Compiling native addon..."
npm run build:cpp -- $RELEASE_FLAG

echo "[build-linux] Staging binary into build/Release/..."
mkdir -p build/Release
if [ -f build/cppws_native.node ]; then
  cp build/cppws_native.node build/Release/
fi

echo "[build-linux] Done. Binary at build/Release/cppws_native.node"
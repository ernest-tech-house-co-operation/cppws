# build-windows.ps1 — build the cppws native addon on Windows
#
# uSockets ships a GNU-style Makefile that MSVC's nmake cannot parse —
# nmake isn't GNU Make, and cl.exe doesn't accept gcc flags like -flto or
# -std=c11. There is no working "build uSockets.a locally" path on MSVC.
# This script uses vcpkg instead, which builds usockets (and libuv) with
# the real MSVC toolchain, producing libraries our cmake-js build can
# actually link against.
#
# Requirements:
#   - Visual Studio 2022 Build Tools (Desktop development with C++ workload)
#   - CMake (in PATH)
#   - Git (in PATH)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 [-Release]

param(
    [switch]$Release
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

Write-Host "[build-windows] Checking system dependencies..."

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    Write-Error "cmake not found in PATH. Install from https://cmake.org/download/ and re-open your shell."
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git not found in PATH. Install from https://git-scm.com/download/win"
    exit 1
}

# vcpkg: bootstrap if missing, then install usockets + libuv
$VcpkgRoot = $env:VCPKG_ROOT
if (-not $VcpkgRoot) {
    $VcpkgRoot = "C:\vcpkg"
}

if (-not (Test-Path "$VcpkgRoot\vcpkg.exe")) {
    Write-Host "[build-windows] vcpkg not found at $VcpkgRoot -- bootstrapping..."
    if (-not (Test-Path $VcpkgRoot)) {
        git clone https://github.com/microsoft/vcpkg.git $VcpkgRoot
    }
    & "$VcpkgRoot\bootstrap-vcpkg.bat" -disableMetrics
}

Write-Host "[build-windows] Installing usockets + libuv via vcpkg (builds them with MSVC)..."
& "$VcpkgRoot\vcpkg.exe" install usockets:x64-windows libuv:x64-windows zlib:x64-windows

$env:VCPKG_ROOT = $VcpkgRoot
$ToolchainFile = "$VcpkgRoot\scripts\buildsystems\vcpkg.cmake"

# uWebSockets headers (App.h etc.) -- still our pinned local clone.
# Only the headers are needed on Windows; the compiled uSockets library
# itself comes from vcpkg above, not from building deps\uWebSockets\uSockets.
Write-Host "[build-windows] Fetching uWebSockets headers (if missing)..."
if (-not (Test-Path "deps\uWebSockets")) {
    git clone --recurse-submodules --depth 1 --branch v20.67.0 `
        https://github.com/uNetworking/uWebSockets.git deps\uWebSockets
} else {
    Write-Host "[build-windows] deps\uWebSockets already present, skipping clone."
}

Write-Host "[build-windows] Installing npm dependencies..."
# CPPWS_SKIP_DOWNLOAD: this script's whole job is to compile the binary
# from source, so postinstall.js has nothing to download yet (the release
# for this version may not even exist). Without this, npm install fails
# the entire build on a 404.
$env:CPPWS_SKIP_DOWNLOAD = "1"
npm install
Remove-Item Env:\CPPWS_SKIP_DOWNLOAD

Write-Host "[build-windows] Compiling native addon..."
$CmakeJsArgs = @("--CDCMAKE_TOOLCHAIN_FILE=$ToolchainFile")
if ($Release) {
    $CmakeJsArgs += "--release"
}
npx cmake-js build @CmakeJsArgs

Write-Host "[build-windows] Staging binary into build\Release\..."
New-Item -ItemType Directory -Force -Path "build\Release" | Out-Null
if (Test-Path "build\cppws_native.node") {
    Copy-Item "build\cppws_native.node" "build\Release\" -Force
}

Write-Host "[build-windows] Done. Binary at build\Release\cppws_native.node"
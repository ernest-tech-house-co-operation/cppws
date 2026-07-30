# build-windows.ps1 — build the cppws native addon on Windows
#
# Requirements:
#   - Visual Studio 2022 Build Tools (Desktop development with C++ workload)
#   - CMake (in PATH)
#   - Git (in PATH)
#   - vcpkg, for libuv (recommended: C:\vcpkg)
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

# libuv via vcpkg (recommended path)
$VcpkgRoot = $env:VCPKG_ROOT
if (-not $VcpkgRoot) {
    $VcpkgRoot = "C:\vcpkg"
}

if (Test-Path "$VcpkgRoot\vcpkg.exe") {
    Write-Host "[build-windows] Ensuring libuv is installed via vcpkg at $VcpkgRoot..."
    & "$VcpkgRoot\vcpkg.exe" install libuv:x64-windows
    $env:CMAKE_TOOLCHAIN_FILE = "$VcpkgRoot\scripts\buildsystems\vcpkg.cmake"
} else {
    Write-Warning "vcpkg not found at $VcpkgRoot. libuv must be discoverable by CMake another way, or set VCPKG_ROOT."
    Write-Warning "Install vcpkg: git clone https://github.com/microsoft/vcpkg && .\vcpkg\bootstrap-vcpkg.bat"
}

Write-Host "[build-windows] Fetching uWebSockets (if missing)..."
if (-not (Test-Path "deps\uWebSockets")) {
    git clone --recurse-submodules --depth 1 --branch v20.67.0 `
        https://github.com/uNetworking/uWebSockets.git deps\uWebSockets
} else {
    Write-Host "[build-windows] deps\uWebSockets already present, skipping clone."
}

Write-Host "[build-windows] Building uSockets.lib..."
Push-Location deps\uWebSockets\uSockets
try {
    # uSockets ships a Makefile; on Windows use its MSVC-compatible build via nmake if present,
    # otherwise fall back to invoking cl.exe directly through the Makefile if nmake is on PATH.
    if (Get-Command nmake -ErrorAction SilentlyContinue) {
        nmake -f Makefile
    } else {
        Write-Warning "nmake not found. Open a 'Developer PowerShell for VS 2022' and re-run this script."
        exit 1
    }
} finally {
    Pop-Location
}

Write-Host "[build-windows] Installing npm dependencies..."
npm install

Write-Host "[build-windows] Compiling native addon..."
if ($Release) {
    npm run build:cpp -- --release
} else {
    npm run build:cpp
}

Write-Host "[build-windows] Staging binary into build\Release\..."
New-Item -ItemType Directory -Force -Path "build\Release" | Out-Null
if (Test-Path "build\cppws_native.node") {
    Copy-Item "build\cppws_native.node" "build\Release\" -Force
}

Write-Host "[build-windows] Done. Binary at build\Release\cppws_native.node"

import { join, dirname } from 'path';
import logger from 'ernest-logger';

// __filename / __dirname / require are ambient CommonJS globals — no need
// for createRequire(import.meta.url) / fileURLToPath, which are ESM-only
// and don't exist in the CommonJS output this package builds to.
const nativeRequire = require;

// ── Runtime detection ─────────────────────────────────────────

type Runtime = 'node' | 'bun' | 'deno';

function detectRuntime(): Runtime {
    if (typeof (globalThis as any).Bun  !== 'undefined') return 'bun';
    if (typeof (globalThis as any).Deno !== 'undefined') return 'deno';
    return 'node';
}

function detectLibc(): string {
    if (process.platform !== 'linux') return '';
    try {
        const fs = nativeRequire('fs') as typeof import('fs');
        const ldd = fs.readFileSync('/usr/bin/ldd', 'utf8');
        return ldd.includes('musl') ? 'musl' : 'gnu';
    } catch {
        return '';
    }
}

function getPlainPlatformTag(): string {
    const libc = process.platform === 'linux' ? detectLibc() : '';
    return `${process.platform}-${process.arch}${libc ? `-${libc}` : ''}`;
}

function findProjectRoot(startDir: string): string {
    const fs = nativeRequire('fs') as typeof import('fs');
    let dir = startDir;
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(join(dir, 'package.json'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return join(startDir, '..', '..');
}

const PROJECT_ROOT = findProjectRoot(__dirname);

// ── Addon loading ─────────────────────────────────────────────

function tryLoadModule(candidatePath: string): unknown | null {
    try {
        return nativeRequire(candidatePath);
    } catch {
        return null;
    }
}

function unwrapAddon(raw: unknown, tag: string): Record<string, (...args: any[]) => any> | null {
    if (!raw || typeof raw !== 'object') return null;
    const mod = raw as Record<string, any>;

    if (typeof mod.configure === 'function') return mod;

    if (typeof mod.WebSocketServer === 'function') {
        try {
            const instance = new mod.WebSocketServer();
            logger.success(`[native-loader] Instantiated WebSocketServer from ${tag}`);
            return instance;
        } catch (e) {
            logger.error(`[native-loader] Failed to instantiate WebSocketServer from ${tag}: ${e}`);
            return null;
        }
    }

    logger.warn(`[native-loader] Addon at ${tag} has unrecognised shape — skipping`);
    return null;
}

/**
 * Tries every known location for the compiled addon, in order:
 *  1. prebuilds/<platform-arch> — staged by postinstall.js (the normal path for consumers)
 *  2. build/Release, build/Debug — a local `npm run build:cpp` (contributor / from-source path)
 *
 * Deno doesn't support native addons, so build/* is skipped there.
 */
function loadNativeAddon(runtime: Runtime): Record<string, (...args: any[]) => any> | null {
    const addonName = 'cppws_native.node';
    const attempted: string[] = [];

    const plainTag = getPlainPlatformTag();
    const s1Path = join(PROJECT_ROOT, 'prebuilds', plainTag, addonName);
    attempted.push(s1Path);
    const s1 = unwrapAddon(tryLoadModule(s1Path), plainTag);
    if (s1) return s1;

    if (runtime !== 'deno') {
        const s2Path = join(PROJECT_ROOT, 'build', 'Release', addonName);
        attempted.push(s2Path);
        const s2 = unwrapAddon(tryLoadModule(s2Path), 'build/Release');
        if (s2) return s2;

        const s3Path = join(PROJECT_ROOT, 'build', 'Debug', addonName);
        attempted.push(s3Path);
        const s3 = unwrapAddon(tryLoadModule(s3Path), 'build/Debug');
        if (s3) return s3;
    }

    logger.error('[native-loader] No native addon found. Looked in:');
    for (const p of attempted) logger.error(`  - ${p}`);
    return null;
}

// ── Public API ────────────────────────────────────────────────

let cachedNative: Record<string, (...args: any[]) => any> | null = null;

/**
 * Load and cache the native C++ addon. Node.js, Bun, and Deno are all
 * supported at runtime.
 *
 * There is no JS fallback: if the compiled addon can't be found, this
 * throws immediately with instructions rather than silently degrading
 * to slower emulated behavior.
 */
export function loadNative(): Record<string, (...args: any[]) => any> {
    if (cachedNative) return cachedNative;

    const runtime = detectRuntime();
    logger.info(`[native-loader] Detected runtime: ${runtime}`);

    const addon = loadNativeAddon(runtime);
    if (!addon) {
        throw new Error(
            '[cppws] Native addon not found.\n' +
            '  If you installed via npm, postinstall should have downloaded it —\n' +
            '  try reinstalling: npm install cppws --force\n' +
            '  If you are building from source: npm run build:cpp\n' +
            '  See https://github.com/ernest-tech-house-co-operation/cppws for supported platforms.'
        );
    }

    cachedNative = addon;
    return cachedNative;
}

/**
 * Always true now that the JS mock has been removed — loadNative() throws
 * instead of ever returning a non-native implementation. Kept for API
 * compatibility with existing callers.
 */
export function isNativeLoaded(): boolean {
    loadNative();
    return true;
}

/**
 * Returns the detected runtime: 'node' | 'bun' | 'deno'.
 */
export function getRuntime(): Runtime {
    return detectRuntime();
}
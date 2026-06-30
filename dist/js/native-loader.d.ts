type Runtime = 'node' | 'bun' | 'deno';
/**
 * Load and cache the native C++ addon (or JS mock fallback).
 * Runtime agnostic: Node.js, Bun, Deno.
 */
export declare function loadNative(): Record<string, (...args: any[]) => any>;
/**
 * Returns true if the real C++ addon is loaded (vs the JS mock).
 */
export declare function isNativeLoaded(): boolean;
/**
 * Returns the detected runtime: 'node' | 'bun' | 'deno'.
 */
export declare function getRuntime(): Runtime;
export {};
//# sourceMappingURL=native-loader.d.ts.map
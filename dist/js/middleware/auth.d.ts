import type { SecurityConfig, AuthConfig } from '../../types/index.js';
/**
 * Extract an authentication token from the upgrade request based on the config.
 * Supports query parameter, Authorization header, and cookie-based auth.
 */
export declare function extractToken(headers: Record<string, string>, query: Record<string, string>, config: AuthConfig): string | null;
/**
 * Validate a token using the configured auth strategy.
 * If a `validate` function is provided, it is used.
 * Otherwise, if a `secret` is provided, a simple HMAC-SHA256 JWT check is performed.
 */
export declare function validateToken(token: string, config: AuthConfig): Promise<Record<string, any> | null>;
/**
 * Create an authentication middleware function for the WebSocket upgrade.
 * Returns a function that takes the Elysia upgrade context and returns
 * a user payload object (or null if auth fails).
 */
export declare function createAuthMiddleware(security: SecurityConfig): (headers: Record<string, string>, query: Record<string, string>) => Promise<Record<string, any> | null>;
//# sourceMappingURL=auth.d.ts.map
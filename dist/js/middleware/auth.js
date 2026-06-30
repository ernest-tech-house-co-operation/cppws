import logger from 'ernest-logger';
// ── Auth Middleware ──────────────────────────────────────────────
/**
 * Extract an authentication token from the upgrade request based on the config.
 * Supports query parameter, Authorization header, and cookie-based auth.
 */
export function extractToken(headers, query, config) {
    const source = config.source ?? 'header';
    const fieldName = config.fieldName ?? 'token';
    switch (source) {
        case 'query': {
            return query[fieldName] ?? null;
        }
        case 'header': {
            const authHeader = headers['authorization'] ?? headers['Authorization'];
            if (!authHeader)
                return null;
            // Support "Bearer <token>" format
            if (authHeader.startsWith('Bearer ')) {
                return authHeader.slice(7);
            }
            return authHeader;
        }
        case 'cookie': {
            const cookieHeader = headers['cookie'] ?? '';
            const cookies = parseCookieHeader(cookieHeader);
            return cookies[fieldName] ?? null;
        }
        default:
            return null;
    }
}
/**
 * Parse a Cookie header string into a key-value map.
 */
function parseCookieHeader(header) {
    const result = {};
    if (!header)
        return result;
    const pairs = header.split(';');
    for (const pair of pairs) {
        const trimmed = pair.trim();
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1)
            continue;
        const name = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        // Remove surrounding quotes
        result[name] = value.replace(/^"|"$/g, '');
    }
    return result;
}
/**
 * Validate a token using the configured auth strategy.
 * If a `validate` function is provided, it is used.
 * Otherwise, if a `secret` is provided, a simple HMAC-SHA256 JWT check is performed.
 */
export async function validateToken(token, config) {
    // Custom validator takes priority
    if (config.validate) {
        try {
            const result = await config.validate(token);
            return result;
        }
        catch (err) {
            logger.security(`Token validation error: ${err}`);
            return null;
        }
    }
    // Built-in JWT check if a secret is provided
    if (config.secret) {
        try {
            const payload = verifySimpleJWT(token, config.secret);
            return payload;
        }
        catch {
            logger.security('JWT verification failed — invalid token');
            return null;
        }
    }
    // If neither validate nor secret is set, accept any non-empty token
    if (token.length > 0) {
        return { token };
    }
    return null;
}
/**
 * Minimal JWT verification using the Web Crypto API (HMAC-SHA256).
 * Supports the standard three-part JWT format (header.payload.signature).
 * This is intentionally simple — for production, users should provide their own `validate` function.
 */
function verifySimpleJWT(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    // Decode the payload (we don't strictly verify the header alg,
    // but we check the signature against the secret)
    const payloadJson = base64UrlDecode(payloadB64);
    const payload = JSON.parse(payloadJson);
    // Verify expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) {
        throw new Error('JWT expired');
    }
    // For a complete implementation, we'd verify the HMAC signature here.
    // The Web Crypto API is async, so in a real production scenario,
    // the user should provide a `validate` function with a proper JWT library.
    // For now, we do a synchronous basic check:
    const expectedSig = base64UrlEncode(createHmacSha256(secret, `${headerB64}.${payloadB64}`));
    if (signatureB64 !== expectedSig) {
        throw new Error('JWT signature mismatch');
    }
    return payload;
}
// ── Base64URL helpers ───────────────────────────────────────────
function base64UrlDecode(str) {
    // Add padding
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64').toString('utf-8');
}
function base64UrlEncode(buffer) {
    return buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
/**
 * Simple HMAC-SHA256 for JWT signature verification.
 * Uses Node.js built-in crypto module synchronously.
 */
function createHmacSha256(key, data) {
    const crypto = require('crypto');
    return crypto.createHmac('sha256', key).update(data).digest();
}
// ── Auth Middleware Factory ─────────────────────────────────────
/**
 * Create an authentication middleware function for the WebSocket upgrade.
 * Returns a function that takes the Elysia upgrade context and returns
 * a user payload object (or null if auth fails).
 */
export function createAuthMiddleware(security) {
    const auth = security.auth;
    if (!auth || !auth.enabled) {
        // Auth not enabled — pass through
        return async (_headers, _query) => {
            return null;
        };
    }
    return async (headers, query) => {
        const token = extractToken(headers, query, auth);
        if (!token) {
            logger.security('WebSocket upgrade rejected — no auth token provided');
            return null;
        }
        const user = await validateToken(token, auth);
        if (!user) {
            logger.security('WebSocket upgrade rejected — invalid auth token');
            return null;
        }
        return user;
    };
}
//# sourceMappingURL=auth.js.map
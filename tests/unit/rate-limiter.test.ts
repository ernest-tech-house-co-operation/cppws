import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSSideRateLimiter, JSSideConnectionThrottler } from '../../src/js/middleware/rate-limit.js';

describe('JSSideRateLimiter', () => {
    let limiter: JSSideRateLimiter;

    beforeEach(() => {
        limiter = new JSSideRateLimiter({
            maxMessagesPerMinute: 5,
            maxPayloadBytes: 1024,
        });
    });

    afterEach(() => {
        limiter.destroy();
    });

    it('should allow messages within the rate limit', () => {
        for (let i = 0; i < 5; i++) {
            expect(limiter.check('conn-1', 100)).toBe(true);
        }
    });

    it('should reject messages that exceed the rate limit', () => {
        for (let i = 0; i < 5; i++) {
            limiter.check('conn-1', 100);
        }
        expect(limiter.check('conn-1', 100)).toBe(false);
    });

    it('should track dropped count per connection', () => {
        for (let i = 0; i < 5; i++) limiter.check('conn-1', 100);
        limiter.check('conn-1', 100); // 6th — should be dropped
        limiter.check('conn-1', 100); // 7th — should be dropped

        expect(limiter.getDroppedCount('conn-1')).toBe(2);
    });

    it('should reject payloads exceeding the max size', () => {
        expect(limiter.check('conn-1', 2000)).toBe(false);
        expect(limiter.getDroppedCount('conn-1')).toBe(1);
    });

    it('should allow a small payload even at the rate limit boundary', () => {
        for (let i = 0; i < 5; i++) limiter.check('conn-1', 100);
        // 6th message but with valid size — should still be rejected due to rate
        expect(limiter.check('conn-1', 500)).toBe(false);
    });

    it('should track connections independently', () => {
        // conn-1 hits its limit
        for (let i = 0; i < 5; i++) limiter.check('conn-1', 100);
        expect(limiter.check('conn-1', 100)).toBe(false);

        // conn-2 should be unaffected
        expect(limiter.check('conn-2', 100)).toBe(true);
        expect(limiter.check('conn-2', 100)).toBe(true);
    });

    it('should allow messages after the time window slides', () => {
        // Fill up the window
        for (let i = 0; i < 5; i++) limiter.check('conn-1', 100);
        expect(limiter.check('conn-1', 100)).toBe(false);

        // Manually simulate time passing by manipulating internal state
        // The real test would use vi.useFakeTimers, but since the limiter uses Date.now()
        // directly, we test via the prune mechanism
        vi.useFakeTimers();
        vi.advanceTimersByTime(61000); // 61 seconds

        // After the window slides, messages should be allowed again
        expect(limiter.check('conn-1', 100)).toBe(true);
        vi.useRealTimers();
    });

    it('should clean up connections on removeConnection()', () => {
        limiter.check('conn-1', 100);
        limiter.check('conn-1', 100);
        limiter.removeConnection('conn-1');

        // After removal, the connection should start fresh
        for (let i = 0; i < 5; i++) {
            expect(limiter.check('conn-1', 100)).toBe(true);
        }
    });

    it('should report tracked connection count', () => {
        expect(limiter.getTrackedCount()).toBe(0);
        limiter.check('conn-1', 100);
        limiter.check('conn-2', 100);
        limiter.check('conn-3', 100);
        expect(limiter.getTrackedCount()).toBe(3);
    });

    it('should clean up after destroy()', () => {
        limiter.check('conn-1', 100);
        limiter.destroy();
        expect(limiter.getTrackedCount()).toBe(0);
    });
});

describe('JSSideConnectionThrottler', () => {
    let throttler: JSSideConnectionThrottler;

    beforeEach(() => {
        throttler = new JSSideConnectionThrottler({ maxConnectionsPerIP: 3 });
    });

    afterEach(() => {
        throttler.destroy();
    });

    it('should allow connections up to the limit', () => {
        expect(throttler.allow('192.168.1.1')).toBe(true);
        expect(throttler.allow('192.168.1.1')).toBe(true);
        expect(throttler.allow('192.168.1.1')).toBe(true);
    });

    it('should reject connections beyond the limit', () => {
        throttler.allow('192.168.1.1');
        throttler.allow('192.168.1.1');
        throttler.allow('192.168.1.1');
        expect(throttler.allow('192.168.1.1')).toBe(false);
    });

    it('should track different IPs independently', () => {
        for (let i = 0; i < 3; i++) throttler.allow('192.168.1.1');
        expect(throttler.allow('192.168.1.1')).toBe(false);
        expect(throttler.allow('10.0.0.1')).toBe(true);
    });

    it('should decrement count on remove()', () => {
        throttler.allow('192.168.1.1');
        throttler.allow('192.168.1.1');
        throttler.allow('192.168.1.1');
        expect(throttler.allow('192.168.1.1')).toBe(false);

        throttler.remove('192.168.1.1');
        expect(throttler.allow('192.168.1.1')).toBe(true);
    });

    it('should report connection count per IP', () => {
        expect(throttler.getCount('192.168.1.1')).toBe(0);
        throttler.allow('192.168.1.1');
        throttler.allow('192.168.1.1');
        expect(throttler.getCount('192.168.1.1')).toBe(2);
    });

    it('should clean up after destroy()', () => {
        throttler.allow('192.168.1.1');
        throttler.destroy();
        expect(throttler.getCount('192.168.1.1')).toBe(0);
    });
});
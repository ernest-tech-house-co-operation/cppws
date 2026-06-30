import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypedEmitter } from '../../src/js/event-emitter.js';

describe('TypedEmitter', () => {
    let emitter: TypedEmitter<{ ping: string; data: number; error: Error }>;

    beforeEach(() => {
        emitter = new TypedEmitter();
    });

    afterEach(() => {
        emitter.removeAllListeners();
    });

    it('should register and call a listener', () => {
        const handler = vi.fn();
        emitter.on('ping', handler);
        emitter.emit('ping', 'hello');
        expect(handler).toHaveBeenCalledWith('hello');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should support multiple listeners for the same event', () => {
        const handler1 = vi.fn();
        const handler2 = vi.fn();
        emitter.on('ping', handler1);
        emitter.on('ping', handler2);
        emitter.emit('ping', 'world');
        expect(handler1).toHaveBeenCalledWith('world');
        expect(handler2).toHaveBeenCalledWith('world');
    });

    it('should support multiple event types', () => {
        const pingHandler = vi.fn();
        const dataHandler = vi.fn();
        emitter.on('ping', pingHandler);
        emitter.on('data', dataHandler);

        emitter.emit('ping', 'test');
        emitter.emit('data', 42);

        expect(pingHandler).toHaveBeenCalledTimes(1);
        expect(dataHandler).toHaveBeenCalledTimes(1);
        expect(dataHandler).toHaveBeenCalledWith(42);
    });

    it('should remove a specific listener with off()', () => {
        const handler1 = vi.fn();
        const handler2 = vi.fn();
        emitter.on('ping', handler1);
        emitter.on('ping', handler2);

        emitter.off('ping', handler1);
        emitter.emit('ping', 'test');

        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).toHaveBeenCalledWith('test');
    });

    it('should support once() — listener fires only once', () => {
        const handler = vi.fn();
        emitter.once('ping', handler);

        emitter.emit('ping', 'first');
        emitter.emit('ping', 'second');

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith('first');
    });

    it('should return false when emitting to an event with no listeners', () => {
        expect(emitter.emit('ping', 'test')).toBe(false);
    });

    it('should return true when at least one listener exists', () => {
        emitter.on('ping', vi.fn());
        expect(emitter.emit('ping', 'test')).toBe(true);
    });

    it('should report correct listener count', () => {
        expect(emitter.listenerCount('ping')).toBe(0);
        emitter.on('ping', vi.fn());
        emitter.on('ping', vi.fn());
        expect(emitter.listenerCount('ping')).toBe(2);
        emitter.off('ping', vi.fn());
        // The specific vi.fn() we passed to off() doesn't match either one
        // since vi.fn() creates a new function each time
        expect(emitter.listenerCount('ping')).toBe(2);
    });

    it('should return correct event names', () => {
        emitter.on('ping', vi.fn());
        emitter.on('data', vi.fn());
        const names = emitter.eventNames();
        expect(names).toContain('ping');
        expect(names).toContain('data');
        expect(names).toHaveLength(2);
    });

    it('should remove all listeners for a specific event', () => {
        emitter.on('ping', vi.fn());
        emitter.on('ping', vi.fn());
        emitter.on('data', vi.fn());

        emitter.removeAllListeners('ping');
        expect(emitter.listenerCount('ping')).toBe(0);
        expect(emitter.listenerCount('data')).toBe(1);
    });

    it('should remove ALL listeners when no event is specified', () => {
        emitter.on('ping', vi.fn());
        emitter.on('data', vi.fn());

        emitter.removeAllListeners();
        expect(emitter.listenerCount('ping')).toBe(0);
        expect(emitter.listenerCount('data')).toBe(0);
    });

    it('should not crash if a listener throws an error', () => {
        const errorHandler = new Error('boom');
        emitter.on('error', () => {
            throw errorHandler;
        });

        // Should not throw even though the handler throws
        expect(() => emitter.emit('error', errorHandler)).not.toThrow();
    });

    it('should allow removing listeners during iteration (once + throw)', () => {
        const handler = vi.fn();
        emitter.once('ping', handler);

        emitter.emit('ping', 'a');
        emitter.emit('ping', 'b');

        expect(handler).toHaveBeenCalledTimes(1);
    });
});
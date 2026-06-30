// ── Typed Event Emitter ──────────────────────────────────────────────────
export class TypedEmitter {
    listeners = new Map();
    on(event, handler) {
        this.addListener(event, handler, false);
        return this;
    }
    once(event, handler) {
        this.addListener(event, handler, true);
        return this;
    }
    off(event, handler) {
        const wrapped = this.listeners.get(event);
        if (!wrapped)
            return this;
        for (const entry of wrapped) {
            if (entry.handler === handler) {
                wrapped.delete(entry);
                break;
            }
        }
        if (wrapped.size === 0) {
            this.listeners.delete(event);
        }
        return this;
    }
    emit(event, data) {
        const wrapped = this.listeners.get(event);
        if (!wrapped || wrapped.size === 0)
            return false;
        // Copy to array to allow safe removal during iteration
        const entries = Array.from(wrapped);
        for (const entry of entries) {
            if (entry.once) {
                wrapped.delete(entry);
            }
            try {
                entry.handler(data);
            }
            catch (err) {
                // Swallow handler errors to prevent crashing the emitter
                console.error(`[TypedEmitter] Error in handler for "${event}":`, err);
            }
        }
        if (wrapped.size === 0) {
            this.listeners.delete(event);
        }
        return true;
    }
    removeAllListeners(event) {
        if (event !== undefined) {
            this.listeners.delete(event);
        }
        else {
            this.listeners.clear();
        }
        return this;
    }
    listenerCount(event) {
        return this.listeners.get(event)?.size ?? 0;
    }
    eventNames() {
        return Array.from(this.listeners.keys());
    }
    addListener(event, handler, once) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add({ handler, once });
    }
}
//# sourceMappingURL=event-emitter.js.map
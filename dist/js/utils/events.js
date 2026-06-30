import { TypedEmitter } from '../event-emitter.js';
// ── Internal Event Bus ────────────────────────────────────────────
/**
 * Singleton-style event bus for internal plugin events.
 * Used by the plugin internals to coordinate between components
 * (e.g., metrics, logging, middleware) without tight coupling.
 */
export class InternalEventBus extends TypedEmitter {
    constructor() {
        super();
    }
}
// Global instance shared across the plugin
let globalBus = null;
/**
 * Get or create the global internal event bus instance.
 */
export function getEventBus() {
    if (!globalBus) {
        globalBus = new InternalEventBus();
    }
    return globalBus;
}
/**
 * Reset the global event bus. Useful for testing.
 */
export function resetEventBus() {
    globalBus = null;
}
//# sourceMappingURL=events.js.map
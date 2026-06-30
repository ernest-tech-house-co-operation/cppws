// ── Typed Event Emitter ──────────────────────────────────────────────────

export type EventMap = Record<string, any>;

export interface Emitter<T extends EventMap> {
    on<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this;
    once<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this;
    off<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this;
    emit<K extends keyof T & string>(event: K, data: T[K]): boolean;
    removeAllListeners(event?: keyof T & string): this;
    listenerCount(event: keyof T & string): number;
    eventNames(): Array<keyof T & string>;
}

type Handler = (...args: any[]) => void;
type WrappedHandler = { handler: Handler; once: boolean };

export class TypedEmitter<T extends EventMap = EventMap> implements Emitter<T> {
    private listeners = new Map<string, Set<WrappedHandler>>();

    on<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this {
        this.addListener(event, handler, false);
        return this;
    }

    once<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this {
        this.addListener(event, handler, true);
        return this;
    }

    off<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this {
        const wrapped = this.listeners.get(event as string);
        if (!wrapped) return this;

        for (const entry of wrapped) {
            if (entry.handler === handler) {
                wrapped.delete(entry);
                break;
            }
        }

        if (wrapped.size === 0) {
            this.listeners.delete(event as string);
        }

        return this;
    }

    emit<K extends keyof T & string>(event: K, data: T[K]): boolean {
        const wrapped = this.listeners.get(event as string);
        if (!wrapped || wrapped.size === 0) return false;

        // Copy to array to allow safe removal during iteration
        const entries = Array.from(wrapped);
        for (const entry of entries) {
            if (entry.once) {
                wrapped.delete(entry);
            }
            try {
                entry.handler(data);
            } catch (err) {
                // Swallow handler errors to prevent crashing the emitter
                console.error(`[TypedEmitter] Error in handler for "${event}":`, err);
            }
        }

        if (wrapped.size === 0) {
            this.listeners.delete(event as string);
        }

        return true;
    }

    removeAllListeners(event?: keyof T & string): this {
        if (event !== undefined) {
            this.listeners.delete(event as string);
        } else {
            this.listeners.clear();
        }
        return this;
    }

    listenerCount(event: keyof T & string): number {
        return this.listeners.get(event as string)?.size ?? 0;
    }

    eventNames(): Array<keyof T & string> {
        return Array.from(this.listeners.keys()) as Array<keyof T & string>;
    }

    private addListener(event: string, handler: Handler, once: boolean): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add({ handler, once });
    }
}
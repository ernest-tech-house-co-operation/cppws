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
export declare class TypedEmitter<T extends EventMap = EventMap> implements Emitter<T> {
    private listeners;
    on<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this;
    once<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this;
    off<K extends keyof T & string>(event: K, handler: (data: T[K]) => void): this;
    emit<K extends keyof T & string>(event: K, data: T[K]): boolean;
    removeAllListeners(event?: keyof T & string): this;
    listenerCount(event: keyof T & string): number;
    eventNames(): Array<keyof T & string>;
    private addListener;
}
//# sourceMappingURL=event-emitter.d.ts.map
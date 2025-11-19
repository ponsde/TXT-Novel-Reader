export function createEventBus() {
    const listeners = new Map();

    return {
        on(event, handler) {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event).add(handler);
            return () => listeners.get(event)?.delete(handler);
        },
        emit(event, payload) {
            const handlers = listeners.get(event);
            if (!handlers) return;
            handlers.forEach(handler => handler(payload));
        }
    };
}

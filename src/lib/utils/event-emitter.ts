export interface TaxContextSubscription {
  unsubscribe(): void;
}

// Minimal synchronous emitter. Its subscribe() returns an object with unsubscribe(), so it
// can be used where an RxJS Subject or an Angular EventEmitter was used before.
export class TaxContextEventEmitter<T> {
  private _listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): TaxContextSubscription {
    // A wrapper keeps each subscription separate when the same function subscribes twice.
    const wrapped = (value: T) => listener(value);
    this._listeners.add(wrapped);
    return { unsubscribe: () => this._listeners.delete(wrapped) };
  }

  emit(value: T): void {
    for (const listener of Array.from(this._listeners)) {
      try {
        listener(value);
      } catch (error) {
        // A failing listener must not break the operation that emitted the event; the
        // error is reported as unhandled instead.
        Promise.reject(error);
      }
    }
  }
}

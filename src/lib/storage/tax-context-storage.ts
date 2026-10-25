// Key-value storage the application provides to the tax register context.
//
// Values are plain JSON-compatible objects and arrays. The storage owns any scoping: an
// application with several companies or tenants passes a storage already bound to the
// current one, so keys never collide between them. Writes must be durable when the
// returned promise resolves: the journal of fiscal documents is kept here.
export interface TaxContextStorage {
  get<T = unknown>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  remove(key: string): Promise<unknown>;
  keys(): Promise<string[]>;
}

// Non-persistent storage for tests and short-lived processes.
export class InMemoryTaxContextStorage implements TaxContextStorage {
  private _values = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this._values.get(key);
    return value === undefined ? undefined : (this._clone(value) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this._values.set(key, this._clone(value));
  }

  async remove(key: string): Promise<void> {
    this._values.delete(key);
  }

  async keys(): Promise<string[]> {
    return Array.from(this._values.keys());
  }

  // Stored values are copies, as with a real storage, so later changes to an object never
  // reach what was saved.
  private _clone(value: unknown): unknown {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
}

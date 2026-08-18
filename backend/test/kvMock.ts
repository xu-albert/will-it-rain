// A small in-memory stand-in for Workers KV, enough for the abuse-gate tests.
//
// It models two behaviours the real thing has and a naive Map does not:
//
//   * expirationTtl, so a test can assert that a record was written to expire
//     rather than to live forever;
//   * read staleness. Workers KV serves `get` from a colo-local cache with a
//     60-second floor, so a burst of requests can all read the same
//     pre-burst value. `staleReads: true` reproduces that, which is the only
//     honest way to test whether a throttle survives a half-second flood.

interface Entry {
  value: string;
  expiresAt: number | null;
}

export interface KVMockOptions {
  /** Serve every read from a snapshot taken before the burst, as a cold colo would. */
  staleReads?: boolean;
  /** Throw on every operation, to exercise the fail-open paths. */
  failing?: boolean;
}

export class KVMock {
  private store = new Map<string, Entry>();
  private snapshot = new Map<string, Entry>();
  readonly options: KVMockOptions;
  puts = 0;

  constructor(options: KVMockOptions = {}) {
    this.options = options;
  }

  /** Freeze what reads will see, simulating a cache that has not caught up. */
  freezeReads(): void {
    this.snapshot = new Map(this.store);
    this.options.staleReads = true;
  }

  thawReads(): void {
    this.options.staleReads = false;
  }

  private live(source: Map<string, Entry>, key: string): Entry | undefined {
    const entry = source.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      source.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string, type?: 'text' | 'json'): Promise<unknown> {
    if (this.options.failing) throw new Error('KV unavailable');
    const source = this.options.staleReads ? this.snapshot : this.store;
    const entry = this.live(source, key);
    if (!entry) return null;
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (this.options.failing) throw new Error('KV unavailable');
    this.puts += 1;
    this.store.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    if (this.options.failing) throw new Error('KV unavailable');
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    if (this.options.failing) throw new Error('KV unavailable');
    const prefix = options?.prefix ?? '';
    const keys = [...this.store.keys()]
      .filter((name) => name.startsWith(prefix) && this.live(this.store, name))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }

  /** Test-only: the TTL a key was written with, in seconds, or null if none. */
  ttlSeconds(key: string): number | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt === null) return null;
    return Math.round((entry.expiresAt - Date.now()) / 1000);
  }

  keysWithPrefix(prefix: string): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }

  raw(key: string): string | undefined {
    return this.store.get(key)?.value;
  }
}

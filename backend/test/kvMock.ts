// A small in-memory stand-in for Workers KV, enough for the abuse-gate tests.
//
// It models two behaviours the real thing has and a naive Map does not:
//
//   * expirationTtl — both that a record was written to expire rather than to
//     live forever, and that `list` reports an `expiration` only for keys that
//     have one, which is how the cron spots pre-TTL records;
//   * read staleness. Workers KV serves `get` from a colo-local cache with a
//     60-second floor, so a burst of requests can all read the same pre-burst
//     value. `staleReads: true` reproduces that. Nothing in the gate counts in
//     KV any more — the counters live in Durable Objects — and a test freezes
//     reads to show the gate holds even so.

interface Entry {
  value: string;
  expiresAt: number | null;
  metadata?: unknown;
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
  deletes = 0;
  lists = 0;

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

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown }
  ): Promise<void> {
    if (this.options.failing) throw new Error('KV unavailable');
    this.puts += 1;
    this.store.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
      metadata: options?.metadata,
    });
  }

  async delete(key: string): Promise<void> {
    if (this.options.failing) throw new Error('KV unavailable');
    // Counted whether or not the key existed: KV bills a delete either way, and
    // that is exactly what makes an unconditional cleanup an amplifier.
    this.deletes += 1;
    this.store.delete(key);
  }

  // `expiration` is present on a listed key only when that key was written with
  // an expirationTtl, exactly as the real KV list does — that absence is the
  // only way to tell a pre-TTL record from a current one.
  async list<Metadata = unknown>(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: Metadata }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    if (this.options.failing) throw new Error('KV unavailable');
    const prefix = options?.prefix ?? '';
    const keys = [...this.store.entries()]
      .filter(([name]) => name.startsWith(prefix) && this.live(this.store, name))
      .map(([name, entry]) => ({
        name,
        ...(entry.expiresAt === null ? {} : { expiration: Math.round(entry.expiresAt / 1000) }),
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata as Metadata }),
      }));
    this.lists += 1;
    return { keys, list_complete: true };
  }

  /** Test-only: plant a record exactly as a pre-TTL deploy left it — no expiration. */
  putWithoutTtl(key: string, value: string): void {
    this.store.set(key, { value, expiresAt: null });
  }

  /**
   * Test-only: how long a key has left, in seconds, or null when it carries no
   * expiry — and null too once it has expired, since a key past its TTL is gone
   * as far as every reader is concerned.
   */
  ttlSeconds(key: string): number | null {
    const entry = this.live(this.store, key);
    if (!entry || entry.expiresAt === null) return null;
    return Math.round((entry.expiresAt - Date.now()) / 1000);
  }

  keysWithPrefix(prefix: string): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }

  /**
   * Test-only: the stored value, honouring expiry. Reading straight out of the
   * backing Map would report an expired record as present, which is exactly the
   * failure a TTL test is looking for.
   */
  raw(key: string): string | undefined {
    return this.live(this.store, key)?.value;
  }
}

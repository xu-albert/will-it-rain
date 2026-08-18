// A stand-in for a Durable Object namespace, running the real DO classes.
//
// It models the two properties the gate depends on and a bare object would not
// have:
//
//   * one instance per name, so `idFromName` twice gives the same state;
//   * serialized delivery. A real Durable Object handles one event at a time and
//     delivers no new event while a storage operation is in flight, which is
//     exactly what makes the read-modify-writes in durable.ts atomic. Requests
//     here queue behind each other for the same reason, so a test that fires 250
//     concurrent registrations exercises the same interleaving production would.
//
// Storage values are structured-cloned on the way in and out, as the real
// storage is, so a handler that mutates an object it read cannot accidentally
// mutate the stored copy.

interface DurableObjectLike {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void>;
}

export interface DurableObjectMockOptions {
  /** Throw on every call, to exercise the fail-open paths. */
  failing?: boolean;
}

class StorageMock {
  private entries = new Map<string, unknown>();
  private alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.entries.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.entries.clear();
    this.alarmAt = null;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
}

class InstanceMock {
  private readonly object: DurableObjectLike;
  private queue: Promise<unknown> = Promise.resolve();
  readonly storage = new StorageMock();

  constructor(ctor: new (state: DurableObjectState) => DurableObjectLike) {
    this.object = new ctor({ storage: this.storage } as unknown as DurableObjectState);
  }

  fetch(input: string, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const next = this.queue.then(() => this.object.fetch(request));
    // Keep the chain alive even if one call rejects, or every later call would
    // inherit that rejection.
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  runAlarm(): Promise<void> {
    return this.object.alarm?.() ?? Promise.resolve();
  }
}

export class DurableObjectNamespaceMock {
  private instances = new Map<string, InstanceMock>();

  constructor(
    private readonly ctor: new (state: DurableObjectState) => DurableObjectLike,
    private readonly options: DurableObjectMockOptions = {}
  ) {}

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(id: { name: string }): { fetch(input: string, init?: RequestInit): Promise<Response> } {
    if (this.options.failing) {
      return {
        fetch: () => Promise.reject(new Error('Durable Object unavailable')),
      };
    }

    let instance = this.instances.get(id.name);
    if (!instance) {
      instance = new InstanceMock(this.ctor);
      this.instances.set(id.name, instance);
    }
    const bound = instance;
    return { fetch: (input, init) => bound.fetch(input, init) };
  }

  /** Test-only: how many distinct instances have been created. */
  get instanceCount(): number {
    return this.instances.size;
  }

  /** Test-only: run an instance's alarm handler, as the runtime eventually would. */
  async runAlarm(name: string): Promise<void> {
    await this.instances.get(name)?.runAlarm();
  }
}

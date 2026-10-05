// The Worker is typed for workerd, so this project carries no Node typings, but
// vitest runs the suites in Node. These are the few Node APIs a test reaches for.

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

// wrangler's DevEnv extends this.
declare module 'node:events' {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
  }
}

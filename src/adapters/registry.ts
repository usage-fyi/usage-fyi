import type { UsageAdapter } from "./types.js";

export const DEFAULT_SOURCE = "ccusage";

/** Thrown by getAdapter() for any source id not in the registry. */
export class UnknownSourceError extends Error {
  readonly source: string;
  constructor(source: string) {
    super(
      `Unknown --source "${source}". Available sources: ${[...registry.keys()].join(", ") || "(none registered yet)"}`,
    );
    this.name = "UnknownSourceError";
    this.source = source;
  }
}

const registry = new Map<string, UsageAdapter>();

/** Register an adapter. Adapters call this themselves; the registry holds no import of their modules. */
export function registerAdapter(adapter: UsageAdapter): void {
  registry.set(adapter.id, adapter);
}

/** Resolve adapter by id, throwing UnknownSourceError for unregistered ids. */
export function getAdapter(id: string): UsageAdapter {
  const adapter = registry.get(id);
  if (adapter === undefined) throw new UnknownSourceError(id);
  return adapter;
}

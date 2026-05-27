import type { Snapshot } from "@usage-fyi/core";

/** Adapter-private raw output; each adapter narrows this to its own concrete type. */
export type RawUsage = unknown;

/** Parameters passed to collect() — date range only, no Style or identity. */
export interface CollectOpts {
  /** Inclusive lower bound, YYYY-MM-DD. Defaults to adapter's natural window. */
  from?: string;
  /** Inclusive upper bound, YYYY-MM-DD. Defaults to today. */
  to?: string;
}

/**
 * Pluggable boundary so adapters beyond ccusage remain a future config
 * concern, not a rewrite ([docs/05-helper-tool]).
 */
export interface UsageAdapter<R = RawUsage> {
  readonly id: string;
  available(): Promise<boolean>;
  collect(opts: CollectOpts): Promise<R>;
  toSnapshot(raw: R): Snapshot;
}

// Wire-shape types — the byte-identical interfaces that producers and consumers
// must both understand. Producer-only and consumer-only types (Link, User,
// Profile, CollectorToken, Event, InterestSignal) live in each side's local
// types module, not here.
//
// Every persisted document carries `schema: "<name>/<int>"`. The literal
// schema strings on these interfaces are part of the wire contract:
// changing one (or its companion validator semantics) is a breaking change
// per docs/26.

// ─── Enum const arrays (source of truth for validators) ───────────────────────

export const DESIGNS = [
  "og",
  "stream",
  "spotlight",
  "bars",
  "ledger",
  "heatmap",
] as const;
export const THEMES = [
  "dark",
  "light",
  "midnight",
  "forest",
  "ocean",
  "mono",
  "chatgpt",
  "twitter",
] as const;
export const FORMATS = ["wide", "portrait"] as const;
export const ORIGINS = ["self-reported", "tool-collected"] as const;

export type Design = (typeof DESIGNS)[number];
export type Theme = (typeof THEMES)[number];
export type Format = (typeof FORMATS)[number];
export type Origin = (typeof ORIGINS)[number];

// ─── Style ────────────────────────────────────────────────────────────────────

export interface Style {
  schema: "style/1";
  design: Design;
  theme: Theme;
  format: Format;
}

export const DEFAULT_STYLE: Style = {
  schema: "style/1",
  design: "og",
  theme: "dark",
  format: "wide",
};

// ─── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * Per-(agent, model) breakdown for one calendar day — the source of truth
 * for attribution in snapshot/2. The day-level `m` and `a` arrays are
 * derivable from `mb[]` but retained verbatim for compact reads.
 *
 * Cost (`c`) is rounded to 2dp on each entry; per-day cost is the rounded
 * sum of these (see slim2 for the deterministic remainder-handling rule).
 */
export interface ModelBreakdown {
  a: string; // agent harness id (e.g. "claude", "codex", "gemini")
  m: string; // model name (e.g. "claude-opus-4-7", "gpt-5.4")
  i: number; // inputTokens
  o: number; // outputTokens
  cc: number; // cacheCreationTokens
  cr: number; // cacheReadTokens
  t: number; // totalTokens
  c: number; // cost, rounded to 2 dp
}

/** One calendar day of usage; short keys keep the embedded JSON small. */
export interface DailyEntry {
  d: string; // date YYYY-MM-DD
  i: number; // inputTokens
  o: number; // outputTokens
  cc: number; // cacheCreationTokens
  cr: number; // cacheReadTokens
  t: number; // totalTokens
  c: number; // totalCost, rounded to 2 dp
  m: string[]; // modelsUsed, deduped + sorted (= sortedUnique(mb[].m))
  a: string[]; // metadata.agents, deduped + sorted (= sortedUnique(mb[].a))
  /**
   * Per-(agent, model) breakdown, sorted ASC by (a, m). Source of truth for
   * attribution; per-day totals (i/o/cc/cr/t) MUST equal sum(mb[*]). Empty
   * only on no-data days.
   */
  mb: ModelBreakdown[];
}

/** Per-window aggregate — same fields as DailyEntry minus date. */
export interface WindowAgg {
  i: number;
  o: number;
  cc: number;
  cr: number;
  t: number;
  c: number;
}

export interface Totals {
  i: number;
  o: number;
  cc: number;
  cr: number;
  t: number;
  c: number;
}

/** Precomputed aggregates so renderers stay dumb ([docs/04], [docs/08]). */
export interface Derived {
  activeDays: number;
  /** Windows anchored to the snapshot's last data date, NOT wall-clock. */
  windows: {
    today: WindowAgg;
    d7: WindowAgg;
    d30: WindowAgg;
    all: WindowAgg;
  };
}

/**
 * Immutable measurement of usage at a point in time.
 * origin is declared by the publisher, recorded verbatim, never upgraded ([docs/21]).
 */
export interface Snapshot {
  schema: "snapshot/2";
  generatedAt: string;
  origin: Origin;
  source: {
    tool: string;
    adapter: string;
    range: [string, string];
  };
  daily: DailyEntry[];
  totals: Totals;
  derived: Derived;
}

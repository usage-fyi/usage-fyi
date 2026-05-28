// Canonical persisted entity types — mirrors docs/04-data-model.md exactly.
// Every persisted document carries schema: "<name>/<int>".

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

// ─── Link ─────────────────────────────────────────────────────────────────────

export interface Link {
  schema: "link/1";
  id: string;
  /** Content hash of the target snapshot — internal dedupe, NOT the public /s/:id key. */
  snapshot: string;
  style: Style;
  /** Declared by the publisher, recorded verbatim, never upgraded server-side ([docs/21]). */
  origin: Origin;
  manageKey: string;
  state: "live" | "tombstoned";
  createdAt: string;
  removedAt?: string;
  visibility: "unlisted";
  owner: null;
}

// ─── User ─────────────────────────────────────────────────────────────────────

/** Deliberately thin — identity only, not profile data. Shape-only in Phase 1. */
export interface User {
  schema: "user/1";
  id: string;
  auth: {
    method: "oauth" | "email-link";
    subject: string;
  };
  createdAt: string;
}

// ─── Profile ──────────────────────────────────────────────────────────────────

/** Shape-only in Phase 1. */
export interface Profile {
  schema: "profile/1";
  username: string;
  owner: string;
  /** Optional public display data, owner-supplied only — never enriched/scraped ([docs/09]). */
  display?: {
    name?: string;
    bio?: string;
    link?: string;
    github?: string;
  };
  current: string;
  history: string[];
  style: Style;
  freshness: {
    updatedAt: string;
    source: "collector" | "manual";
  };
}

// ─── CollectorToken ───────────────────────────────────────────────────────────

/** Shape-only in Phase 1. Scoped to one profile, publish-only. */
export interface CollectorToken {
  schema: "token/1";
  id: string;
  profile: string;
  scope: string[];
  createdAt: string;
  lastUsedAt: string;
  revoked: boolean;
}

// ─── Event ────────────────────────────────────────────────────────────────────

/** Privacy-preserving instrumentation — no PII, no snapshot content ([docs/04], [docs/17]). */
export interface Event {
  schema: "event/1";
  type: string;
  surface: "paste" | "command" | "helper" | "mcp" | "page" | "og";
  phase: number;
  day: string;
  shareRef?: string;
}

// ─── InterestSignal ───────────────────────────────────────────────────────────

/** The only entity that may hold PII — and only by explicit opt-in ([docs/04], [docs/19]). */
export interface InterestSignal {
  schema: "interest/1";
  feature: string;
  contact: { email: string } | { user: string };
  relatedUpdates: boolean;
  consent: {
    copyVersion: string;
    scope: "notify" | "notify+related";
    at: string;
    confirmed: boolean;
  };
  createdAt: string;
  lastEngagedAt: string;
}

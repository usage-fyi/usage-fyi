import type {
  Snapshot,
  DailyEntry,
  ModelBreakdown,
  Totals,
  WindowAgg,
  Origin,
} from "./types.js";

// ─── Raw input shapes ─────────────────────────────────────────────────────

/**
 * Unified ccusage `daily --json` row. Source of truth for per-(date, model)
 * numbers via modelBreakdowns[].
 */
interface RawDailyEntry {
  period: string;
  modelsUsed?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  totalCost?: number;
  metadata?: {
    agents?: string[];
  };
  /**
   * Per-(date, model) breakdown emitted by ccusage's unified `daily` command.
   * Present in current ccusage; absent in older fixtures.
   */
  modelBreakdowns?: RawModelBreakdown[];
}

interface RawModelBreakdown {
  modelName: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  cost?: number;
}

/**
 * Per-agent subcommand row, e.g. `ccusage claude daily --json`.
 * Schema is INCONSISTENT across agents; we use it only as an attribution
 * lookup ("model X on date D was used through agent A"), never as a numeric
 * source. Known shapes observed:
 *
 *  - claude / gemini / kimi / qwen / pi: keys `date`, `modelsUsed[]`,
 *    sometimes `modelBreakdowns[]` with `modelName`.
 *  - codex: keys `date`, `models` as an OBJECT keyed by model name,
 *    `cachedInputTokens`, `costUSD`.
 *
 * Accept both shapes leniently — only the model names per date matter.
 */
interface RawAgentDailyEntry {
  date?: string;
  period?: string;
  modelsUsed?: string[];
  modelBreakdowns?: { modelName?: string }[];
  models?: Record<string, unknown>;
}

export interface RawAgentDaily {
  daily?: RawAgentDailyEntry[];
}

/**
 * Bundle passed from the adapter into slim():
 *   - unified: result of `ccusage daily --json` (primary numbers + agents list)
 *   - perAgent: map from agent id → result of `ccusage <agent> daily --json`
 *     (used as attribution lookup only). Optional; an empty map falls back to
 *     name-prefix inference.
 */
export interface RawCcusage {
  daily: RawDailyEntry[];
  /** Per-agent attribution lookup; agent id → per-agent daily JSON. */
  perAgent?: Record<string, RawAgentDaily>;
}

export interface SlimOpts {
  origin: Origin;
  /** Tool name recorded in source.tool (default: "ccusage"). */
  tool?: string;
  /** Adapter version recorded in source.adapter (default: "2"). */
  adapter?: string;
  /**
   * ISO timestamp for generatedAt. Must be injectable so golden tests
   * reproduce byte-identical output — never call Date.now() here.
   */
  generatedAt: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Date arithmetic using UTC to avoid DST surprises. */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function zeroAgg(): WindowAgg {
  return { i: 0, o: 0, cc: 0, cr: 0, t: 0, c: 0 };
}

function addToAgg(agg: WindowAgg, entry: DailyEntry): void {
  agg.i += entry.i;
  agg.o += entry.o;
  agg.cc += entry.cc;
  agg.cr += entry.cr;
  agg.t += entry.t;
  agg.c += entry.c;
}

function finalizeAgg(agg: WindowAgg): WindowAgg {
  return { ...agg, c: round2(agg.c) };
}

// ─── Attribution ──────────────────────────────────────────────────────────

/**
 * Strip ccusage's `[pi] ` prefix and similar harness annotations from a model
 * name. Used purely for prefix-based fallback inference, not for the wire.
 */
function stripHarnessPrefix(model: string): string {
  // `[pi] qwen3-coder:latest` → `qwen3-coder:latest`
  const m = model.match(/^\[([^\]]+)\]\s+(.+)$/);
  return m ? m[2]! : model;
}

/**
 * Last-resort agent inference from a model name. Only used when no per-agent
 * subcommand claims the (date, model). Mirrors ccusage's own subcommand
 * naming.
 */
function inferAgentFromModel(model: string): string {
  const name = stripHarnessPrefix(model).toLowerCase();
  if (name.startsWith("claude-")) return "claude";
  if (
    name.startsWith("gpt-") ||
    name.startsWith("codex-") ||
    name.startsWith("o1-") ||
    name.startsWith("o3-")
  )
    return "codex";
  if (name.startsWith("gemini-")) return "gemini";
  if (name.startsWith("kimi-") || name.startsWith("moonshot-")) return "kimi";
  if (name.startsWith("qwen")) return "qwen";
  return "other";
}

/**
 * Extract (date, modelName) → set of agents from per-agent subcommand JSONs.
 *
 * Per-agent schemas vary, so we read defensively: accept either `date` or
 * `period`, either `modelsUsed[]`, `modelBreakdowns[].modelName`, or
 * `models` (object keyed by model name). Numbers are intentionally ignored.
 */
function buildAttributionLookup(
  perAgent: Record<string, RawAgentDaily> | undefined,
): Map<string, Set<string>> {
  const lookup = new Map<string, Set<string>>();
  if (!perAgent) return lookup;

  for (const [agent, payload] of Object.entries(perAgent)) {
    const daily = payload?.daily ?? [];
    for (const row of daily) {
      const date = row.date ?? row.period;
      if (typeof date !== "string" || date === "") continue;

      const models = new Set<string>();
      if (Array.isArray(row.modelsUsed)) {
        for (const m of row.modelsUsed)
          if (typeof m === "string") models.add(m);
      }
      if (Array.isArray(row.modelBreakdowns)) {
        for (const mb of row.modelBreakdowns) {
          if (typeof mb?.modelName === "string") models.add(mb.modelName);
        }
      }
      if (row.models && typeof row.models === "object") {
        for (const m of Object.keys(row.models)) models.add(m);
      }

      for (const model of models) {
        const key = `${date}\x00${model}`;
        let agents = lookup.get(key);
        if (!agents) {
          agents = new Set<string>();
          lookup.set(key, agents);
        }
        agents.add(agent);
      }
    }
  }
  return lookup;
}

/**
 * For an ambiguous (date, model) claimed by multiple agents, distribute the
 * day-level numbers across them. Returns ratios that sum to 1.0 in agent
 * order (alphabetical). We don't have reliable per-agent per-model numeric
 * weights (codex has different keys; gemini has no per-model split at all),
 * so we split evenly. This is rare in practice (most ambiguity is just one
 * model used by one harness on one day).
 */
function evenSplit(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

// ─── slim() — snapshot/2 ───────────────────────────────────────────────────

/**
 * Pure deterministic transform: ccusage --daily JSON (+ per-agent
 * attribution lookups) → snapshot/2.
 *
 * Attribution algorithm:
 *
 *   1. Take per-(date, model) numbers from `raw.daily[].modelBreakdowns`
 *      (the unified ccusage call). These are the source of truth for
 *      numbers — they always sum back to the day totals by construction.
 *   2. Build a (date, model) → {agents claiming it} lookup from the
 *      per-agent subcommand JSONs in `raw.perAgent`.
 *   3. For each (date, model):
 *      - Unambiguous (exactly one agent claims it): emit one mb entry with
 *        the full per-(date, model) numbers under that agent.
 *      - Ambiguous (>1 agents claim it): split numbers evenly across the
 *        claiming agents (alphabetical order). Tokens use integer division
 *        with the remainder dropped onto the first agent so the day total
 *        still matches. Costs use 2dp rounding with the rounding remainder
 *        steered onto the first agent for the same reason.
 *      - No claimant (rare data race or `raw.perAgent` not provided):
 *        fall back to `inferAgentFromModel` on the model name.
 *   4. Sort mb[] ASC by (a, m). Daily-level m/a are re-derived from mb[]
 *      as sortedUnique. Daily-level numeric fields are recomputed as the
 *      exact integer sums of mb[]; daily-level cost is round2(sum of mb c).
 *
 * Invariants the server validator enforces (verified locally in tests):
 *   1. sum(daily[].mb[*].{i,o,cc,cr,t}) === daily[].{i,o,cc,cr,t}
 *   2. daily[].c === round2(sum(daily[].mb[*].c))
 *   3. daily[].m === sortedUnique(daily[].mb[*].m)
 *   4. daily[].a === sortedUnique(daily[].mb[*].a)
 *   5. daily[].mb sorted ASC by (a, m); empty only on no-data days.
 *
 * Determinism: daily is sorted ascending by d before summation;
 * generatedAt is injected via opts (never Date.now()); cost rounded once
 * per agg at the end to avoid cumulative fp drift; ambiguous-split
 * remainders deterministically assigned to alphabetically-first agent.
 *
 * Backwards compat: when `raw.daily[i].modelBreakdowns` is absent (older
 * fixtures from before ccusage emitted per-model breakdowns), we synthesise
 * a single breakdown per day from the day-level totals, assigning it to the
 * first metadata.agents entry (or "other"). The resulting day is honest
 * about the loss of resolution.
 *
 * origin is taken verbatim from opts — declared by the publisher, never
 * derived from the data ([docs/21]).
 *
 * Empty daily: all totals 0, activeDays 0, windows 0, range ["",""].
 */
export function slim(raw: RawCcusage, opts: SlimOpts): Snapshot {
  const { origin, generatedAt } = opts;
  const tool = opts.tool ?? "ccusage";
  const adapter = opts.adapter ?? "2";

  const attribution = buildAttributionLookup(raw.perAgent);

  // Sort raw daily ASC by date for deterministic summation.
  const sortedRaw = [...raw.daily].sort((a, b) =>
    a.period < b.period ? -1 : a.period > b.period ? 1 : 0,
  );

  const daily: DailyEntry[] = sortedRaw.map((r) =>
    buildDailyEntry(r, attribution),
  );

  // totals — sum over sorted daily, round cost once at the end.
  const totals: Totals = { i: 0, o: 0, cc: 0, cr: 0, t: 0, c: 0 };
  for (const e of daily) {
    totals.i += e.i;
    totals.o += e.o;
    totals.cc += e.cc;
    totals.cr += e.cr;
    totals.t += e.t;
    totals.c += e.c;
  }
  totals.c = round2(totals.c);

  // activeDays — days with any token usage or non-zero cost.
  let activeDays = 0;
  for (const e of daily) {
    if (e.i > 0 || e.o > 0 || e.cc > 0 || e.cr > 0 || e.t > 0 || e.c > 0) {
      activeDays++;
    }
  }

  // range
  const range: [string, string] =
    daily.length === 0 ? ["", ""] : [daily[0]!.d, daily[daily.length - 1]!.d];

  // derived.windows — anchor to last data date, NOT wall-clock.
  const anchor = range[1];
  const todayAgg = zeroAgg();
  const d7Agg = zeroAgg();
  const d30Agg = zeroAgg();
  const allAgg = zeroAgg();

  if (anchor !== "") {
    const d7Start = subtractDays(anchor, 6); // 7 days inclusive
    const d30Start = subtractDays(anchor, 29); // 30 days inclusive

    for (const e of daily) {
      addToAgg(allAgg, e);
      if (e.d >= d30Start) addToAgg(d30Agg, e);
      if (e.d >= d7Start) addToAgg(d7Agg, e);
      if (e.d === anchor) addToAgg(todayAgg, e);
    }
  }

  return {
    schema: "snapshot/2",
    generatedAt,
    origin,
    source: { tool, adapter, range },
    daily,
    totals,
    derived: {
      activeDays,
      windows: {
        today: finalizeAgg(todayAgg),
        d7: finalizeAgg(d7Agg),
        d30: finalizeAgg(d30Agg),
        all: finalizeAgg(allAgg),
      },
    },
  };
}

// ─── per-day mb[] construction ────────────────────────────────────────────

/**
 * Build one DailyEntry — including its mb[] breakdown — from one raw day.
 * Encapsulates the per-day attribution logic so the top-level slim() stays
 * focused on cross-day aggregation.
 */
function buildDailyEntry(
  r: RawDailyEntry,
  attribution: Map<string, Set<string>>,
): DailyEntry {
  const date = r.period;
  const dayTotals = {
    i: r.inputTokens ?? 0,
    o: r.outputTokens ?? 0,
    cc: r.cacheCreationTokens ?? 0,
    cr: r.cacheReadTokens ?? 0,
    t: r.totalTokens ?? 0,
    c: r.totalCost ?? 0,
  };

  // No-data day: empty mb, zero day totals.
  const isEmptyDay =
    dayTotals.i === 0 &&
    dayTotals.o === 0 &&
    dayTotals.cc === 0 &&
    dayTotals.cr === 0 &&
    dayTotals.t === 0 &&
    dayTotals.c === 0;

  if (isEmptyDay) {
    return {
      d: date,
      i: 0,
      o: 0,
      cc: 0,
      cr: 0,
      t: 0,
      c: 0,
      m: [],
      a: [],
      mb: [],
    };
  }

  // Build per-(model) numeric breakdown. Prefer ccusage's own
  // modelBreakdowns[] — it always sums to the day totals exactly.
  const perModel: {
    model: string;
    i: number;
    o: number;
    cc: number;
    cr: number;
    t: number;
    c: number;
  }[] = [];

  if (Array.isArray(r.modelBreakdowns) && r.modelBreakdowns.length > 0) {
    for (const mb of r.modelBreakdowns) {
      const i = mb.inputTokens ?? 0;
      const o = mb.outputTokens ?? 0;
      const cc = mb.cacheCreationTokens ?? 0;
      const cr = mb.cacheReadTokens ?? 0;
      // ccusage's modelBreakdowns[] currently omits totalTokens; compute it
      // from the components so day-level `t` reconstructs correctly via the
      // mb sum (invariant 1). Fall back to the explicit field if present.
      const t = mb.totalTokens ?? i + o + cc + cr;
      perModel.push({
        model: mb.modelName,
        i,
        o,
        cc,
        cr,
        t,
        c: mb.cost ?? 0,
      });
    }
  } else {
    // Legacy: no modelBreakdowns. Fall back to one bucket per model in
    // modelsUsed (split evenly), or a single "unknown-model" bucket.
    const models = (r.modelsUsed ?? []).filter((m) => typeof m === "string");
    if (models.length === 0) {
      perModel.push({
        model: "unknown",
        ...dayTotals,
      });
    } else {
      const n = models.length;
      const ratios = evenSplit(n);
      // Distribute tokens with integer remainder onto first model (sorted).
      const sortedModels = [...models].sort();
      const parts = distribute(dayTotals, ratios);
      for (let k = 0; k < sortedModels.length; k++) {
        perModel.push({ model: sortedModels[k]!, ...parts[k]! });
      }
    }
  }

  // Attribute each perModel bucket to one or more agents.
  const mb: ModelBreakdown[] = [];
  for (const pm of perModel) {
    const key = `${date}\x00${pm.model}`;
    const claiming = attribution.get(key);

    let agents: string[];
    if (claiming && claiming.size > 0) {
      agents = [...claiming].sort();
    } else {
      agents = [inferAgentFromModel(pm.model)];
    }

    if (agents.length === 1) {
      mb.push({
        a: agents[0]!,
        m: pm.model,
        i: pm.i,
        o: pm.o,
        cc: pm.cc,
        cr: pm.cr,
        t: pm.t,
        c: round2(pm.c),
      });
    } else {
      // Even split across claiming agents (alphabetical). Deterministic
      // remainder handling: integer-divide for tokens with remainder added
      // to first agent; 2dp-round per agent with cost remainder added to
      // first agent so the per-day cost (the rounded sum) is unchanged.
      const ratios = evenSplit(agents.length);
      const parts = distribute(pm, ratios);
      for (let k = 0; k < agents.length; k++) {
        const p = parts[k]!;
        mb.push({
          a: agents[k]!,
          m: pm.model,
          i: p.i,
          o: p.o,
          cc: p.cc,
          cr: p.cr,
          t: p.t,
          c: round2(p.c),
        });
      }
    }
  }

  // Sort mb[] ASC by (a, m) for determinism.
  mb.sort((x, y) =>
    x.a < y.a ? -1 : x.a > y.a ? 1 : x.m < y.m ? -1 : x.m > y.m ? 1 : 0,
  );

  // Recompute day-level totals from mb[] to maintain invariant 1.
  // For tokens this is an exact integer sum; for cost it's the rounded sum
  // (so daily.c === round2(sum(mb.c)) ≡ invariant 2).
  let i = 0;
  let o = 0;
  let cc = 0;
  let cr = 0;
  let t = 0;
  let cSum = 0;
  for (const e of mb) {
    i += e.i;
    o += e.o;
    cc += e.cc;
    cr += e.cr;
    t += e.t;
    cSum += e.c;
  }

  const m = [...new Set(mb.map((e) => e.m))].sort();
  const a = [...new Set(mb.map((e) => e.a))].sort();

  return {
    d: date,
    i,
    o,
    cc,
    cr,
    t,
    c: round2(cSum),
    m,
    a,
    mb,
  };
}

/**
 * Distribute (i, o, cc, cr, t, c) across N buckets according to `ratios`
 * (which must sum to 1.0). Tokens use integer floor; the integer remainder
 * is added to bucket 0 so sums are exact. Cost is multiplied unrounded and
 * the caller is responsible for round2 + remainder handling (here we just
 * steer the rounding remainder onto bucket 0 so round2(sum(c)) is stable).
 */
function distribute(
  src: { i: number; o: number; cc: number; cr: number; t: number; c: number },
  ratios: number[],
): { i: number; o: number; cc: number; cr: number; t: number; c: number }[] {
  const n = ratios.length;
  const parts = ratios.map((r) => ({
    i: Math.floor(src.i * r),
    o: Math.floor(src.o * r),
    cc: Math.floor(src.cc * r),
    cr: Math.floor(src.cr * r),
    t: Math.floor(src.t * r),
    c: src.c * r,
  }));

  // Integer-token remainders → bucket 0 (alphabetically-first agent).
  const assign = (key: "i" | "o" | "cc" | "cr" | "t", total: number) => {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += parts[k]![key];
    const remainder = total - sum;
    if (remainder !== 0) parts[0]![key] += remainder;
  };
  assign("i", src.i);
  assign("o", src.o);
  assign("cc", src.cc);
  assign("cr", src.cr);
  assign("t", src.t);

  // Cost remainder: ensure round2(sum(parts.c)) === round2(src.c) by
  // steering the float-residual onto bucket 0 BEFORE the caller rounds.
  let csum = 0;
  for (let k = 0; k < n; k++) csum += parts[k]!.c;
  parts[0]!.c += src.c - csum;

  return parts;
}

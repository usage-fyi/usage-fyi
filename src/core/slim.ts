import type { Snapshot, DailyEntry, Totals, WindowAgg, Origin } from './types.js';

// ─── Raw input shape (ccusage --daily output) ──────────────────────────────

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
}

export interface RawCcusage {
  daily: RawDailyEntry[];
}

export interface SlimOpts {
  origin: Origin;
  /** Tool name recorded in source.tool (default: "ccusage"). */
  tool?: string;
  /** Adapter version recorded in source.adapter (default: "1"). */
  adapter?: string;
  /**
   * ISO timestamp for generatedAt. Must be injectable so golden tests
   * reproduce byte-identical output — never call Date.now() here.
   */
  generatedAt: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

const dedupeSort = (arr: string[] | undefined): string[] =>
  arr === undefined ? [] : [...new Set(arr)].sort();

/** Date arithmetic using UTC to avoid DST surprises. */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
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

// ─── slim() ────────────────────────────────────────────────────────────────

/**
 * Pure deterministic transform: ccusage --daily JSON → snapshot/1.
 *
 * Determinism guarantees: daily is sorted ascending by d before summation;
 * generatedAt is injected via opts (never Date.now()); cost rounded once per
 * window at the end to avoid cumulative fp drift.
 *
 * origin is taken verbatim from opts — declared by the publisher, never
 * derived from the data ([docs/21]).
 *
 * Empty daily: all totals 0, activeDays 0, windows 0, range ["",""].
 */
export function slim(raw: RawCcusage, opts: SlimOpts): Snapshot {
  const { origin, generatedAt } = opts;
  const tool = opts.tool ?? 'ccusage';
  const adapter = opts.adapter ?? '1';

  // Map raw entries to DailyEntry, sort ascending by d for deterministic summation.
  const daily: DailyEntry[] = raw.daily
    .map(
      (r): DailyEntry => ({
        d: r.period,
        i: r.inputTokens ?? 0,
        o: r.outputTokens ?? 0,
        cc: r.cacheCreationTokens ?? 0,
        cr: r.cacheReadTokens ?? 0,
        t: r.totalTokens ?? 0,
        c: round2(r.totalCost ?? 0),
        m: dedupeSort(r.modelsUsed),
        a: dedupeSort(r.metadata?.agents),
      })
    )
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

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
    daily.length === 0
      ? ['', '']
      : [daily[0]!.d, daily[daily.length - 1]!.d];

  // derived.windows — anchor to last data date, NOT wall-clock.
  const anchor = range[1];
  const todayAgg = zeroAgg();
  const d7Agg = zeroAgg();
  const d30Agg = zeroAgg();
  const allAgg = zeroAgg();

  if (anchor !== '') {
    const d7Start = subtractDays(anchor, 6);   // 7 days inclusive
    const d30Start = subtractDays(anchor, 29);  // 30 days inclusive

    for (const e of daily) {
      addToAgg(allAgg, e);
      if (e.d >= d30Start) addToAgg(d30Agg, e);
      if (e.d >= d7Start) addToAgg(d7Agg, e);
      if (e.d === anchor) addToAgg(todayAgg, e);
    }
  }

  return {
    schema: 'snapshot/1',
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

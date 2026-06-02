// Per-project PR-event aggregation with latency percentiles and token windowing.
//
// aggregate(): Takes PR events and session metadata, computes per-project stats
// keyed by canonical project path. Sessions with no PRs are counted but excluded
// from latency percentiles. Negative ms-to-first-PR is clamped to 0 with a debug
// log.
//
// windowSession(): Pure function that partitions a session's token events into
// per-PR windows and computes productive/overhead splits.
//
// aggregateTokensByProject(): Rolls up per-session window results into
// per-project efficiency metrics (dryTokenShare, tokensPerPR, prsPerMTok, etc).

import {
  type TokenBreakdown,
  type TokenEvent,
  zeroBreakdown,
} from "./sources/tokenTypes.js";

// ─── Input shapes ───────────────────────────────────────────────────────────

export interface AggregateEvent {
  /** Canonical project path (e.g. "usage-fyi/usage-fyi"). */
  project: string;
  /** Session that created the PR. */
  sessionId: string;
  /** ISO-8601 timestamp of PR creation. */
  createdAt: string;
}

export interface AggregateSessionMeta {
  /** Canonical project path. */
  project: string;
  sessionId: string;
  /** ISO-8601 timestamp of session start. */
  startedAt: string;
}

// ─── Output shapes ──────────────────────────────────────────────────────────

export interface ProjectStats {
  prCount: number;
  sessionCount: number;
  sessionsWithNoPR: number;
  /** Null when no session in this project has any PRs. */
  medianMsToFirstPR: number | null;
  /** Null when no session in this project has any PRs. */
  p90MsToFirstPR: number | null;
}

export interface AggregateResult {
  byProject: Record<string, ProjectStats>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAsc[mid]!;
  return (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}

function p90(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const idx = Math.ceil(0.9 * n) - 1;
  return sortedAsc[Math.max(0, idx)]!;
}

// ─── aggregate() ────────────────────────────────────────────────────────────

/**
 * Aggregate PR events into per-project stats.
 *
 * - `prCount` counts every event whose `project` matches, even if the session
 *   is not present in `sessionMetas`.
 * - `sessionCount` and `sessionsWithNoPR` are driven by `sessionMetas`.
 * - Latency percentiles include only sessions that have at least one PR.
 * - `msToFirstPR` is `earliestPR - sessionStart`. Negative values are clamped
 *   to 0 and a debug message is emitted.
 */
export function aggregate(
  events: AggregateEvent[],
  sessionMetas: AggregateSessionMeta[],
): AggregateResult {
  // Collect every project seen in either input.
  const allProjects = new Set<string>();
  for (const m of sessionMetas) allProjects.add(m.project);
  for (const e of events) allProjects.add(e.project);

  // Group sessions by project.
  const sessionsByProject = new Map<string, AggregateSessionMeta[]>();
  for (const m of sessionMetas) {
    const list = sessionsByProject.get(m.project);
    if (list) list.push(m);
    else sessionsByProject.set(m.project, [m]);
  }

  // Group events by project (for prCount) and by (project, sessionId) (for latency).
  const eventsByProject = new Map<string, AggregateEvent[]>();
  const eventsBySession = new Map<string, AggregateEvent[]>();
  for (const e of events) {
    const projList = eventsByProject.get(e.project);
    if (projList) projList.push(e);
    else eventsByProject.set(e.project, [e]);

    const sessionKey = `${e.project}\x00${e.sessionId}`;
    const sessList = eventsBySession.get(sessionKey);
    if (sessList) sessList.push(e);
    else eventsBySession.set(sessionKey, [e]);
  }

  const byProject: Record<string, ProjectStats> = {};

  for (const project of allProjects) {
    const sessions = sessionsByProject.get(project) ?? [];
    const projectEvents = eventsByProject.get(project) ?? [];

    let sessionsWithNoPR = 0;
    const msToFirstPRs: number[] = [];

    for (const session of sessions) {
      const sessionKey = `${session.project}\x00${session.sessionId}`;
      const sessEvents = eventsBySession.get(sessionKey) ?? [];

      if (sessEvents.length === 0) {
        sessionsWithNoPR++;
        continue;
      }

      let earliest = Infinity;
      for (const ev of sessEvents) {
        const t = toMs(ev.createdAt);
        if (t < earliest) earliest = t;
      }

      const startedAt = toMs(session.startedAt);
      let ms = earliest - startedAt;
      if (ms < 0) {
        // eslint-disable-next-line no-console
        console.debug(
          `Negative msToFirstPR (${ms}ms) for session ${session.sessionId} in project ${project}; clamping to 0.`,
        );
        ms = 0;
      }
      msToFirstPRs.push(ms);
    }

    const sorted = [...msToFirstPRs].sort((a, b) => a - b);

    byProject[project] = {
      prCount: projectEvents.length,
      sessionCount: sessions.length,
      sessionsWithNoPR,
      medianMsToFirstPR: sorted.length === 0 ? null : median(sorted),
      p90MsToFirstPR: sorted.length === 0 ? null : p90(sorted),
    };
  }

  return { byProject };
}

// ─── Token-windowing types ───────────────────────────────────────────────────

export interface PRInput {
  prUrl: string;
  prTimestamp: string;
}

export interface WindowSessionInput {
  sessionId: string;
  project: string;
  sessionStart: string;
  sessionEnd: string | null;
  prs: PRInput[];
  tokens: TokenEvent[];
}

export interface PRWindowResult {
  prUrl: string;
  prTimestamp: string;
  tokens: TokenBreakdown;
  sidechainTokens: TokenBreakdown;
  /** ms from window start (sessionStart or prev PR) to this PR. */
  msToPR: number;
  /** ms from the immediately preceding PR; null for the first PR. */
  msFromPrevPR: number | null;
  models: string[];
  tokensAttributed: "windowed" | "session-only" | "approximate";
  /** True when every token event in this window had usageMissing. */
  usageMissing: boolean;
}

export interface SessionStats {
  sessionId: string;
  project: string;
  durationMs: number;
  prCount: number;
  tokens: TokenBreakdown;
  sidechainTokens: TokenBreakdown;
  models: string[];
  outputShare: number | null;
  cacheHitRatio: number | null;
  tokensPerActiveMinute: number | null;
  tokensAttributed: "windowed" | "session-only" | "approximate";
}

export interface WindowSessionResult {
  session: SessionStats;
  perPR: PRWindowResult[];
  overhead: TokenBreakdown;
  overheadSidechain: TokenBreakdown;
  isDrySession: boolean;
}

export interface ProjectTokenStats {
  productiveTokens: TokenBreakdown;
  dryTokens: TokenBreakdown;
  overheadTokens: TokenBreakdown;
  sidechainTokens: TokenBreakdown;
  totalTokens: TokenBreakdown;
  /** dry tokens / total tokens (0..1). */
  dryTokenShare: number;
  /** productive tokens / PR count; null if prCount = 0. */
  tokensPerPR: number | null;
  /** PRs / million tokens; null if totalTokens = 0. */
  prsPerMTok: number | null;
  /** cacheReadTokens / (inputTokens + cacheReadTokens); null if denominator = 0. */
  cacheHitRatio: number | null;
  /** outputTokens / totalTokens; null if totalTokens = 0. */
  outputShare: number | null;
}

// ─── Token-windowing helpers ─────────────────────────────────────────────────

function parseTs(ts: string): number | null {
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function sumBreakdowns(bs: TokenBreakdown[]): TokenBreakdown {
  const r = zeroBreakdown();
  for (const b of bs) {
    r.inputTokens += b.inputTokens;
    r.outputTokens += b.outputTokens;
    r.cacheReadTokens += b.cacheReadTokens;
    r.cacheCreationTokens += b.cacheCreationTokens;
    r.reasoningTokens += b.reasoningTokens;
    r.totalTokens += b.totalTokens;
  }
  return r;
}

function addBreakdowns(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function scaleBreakdown(b: TokenBreakdown, factor: number): TokenBreakdown {
  return {
    inputTokens: b.inputTokens * factor,
    outputTokens: b.outputTokens * factor,
    cacheReadTokens: b.cacheReadTokens * factor,
    cacheCreationTokens: b.cacheCreationTokens * factor,
    reasoningTokens: b.reasoningTokens * factor,
    totalTokens: b.totalTokens * factor,
  };
}

function uniqueModels(events: TokenEvent[]): string[] {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.model !== null) seen.add(e.model);
  }
  return [...seen].sort();
}

function calcOutputShare(b: TokenBreakdown): number | null {
  return b.totalTokens > 0 ? b.outputTokens / b.totalTokens : null;
}

function calcCacheHitRatio(b: TokenBreakdown): number | null {
  const denom = b.inputTokens + b.cacheReadTokens;
  return denom > 0 ? b.cacheReadTokens / denom : null;
}

// ─── windowSession() ────────────────────────────────────────────────────────

/**
 * Partition a session's token events into per-PR windows.
 *
 * Window boundaries (decided):
 *   window_1  = [sessionStart, pr_1.ts)   — first PR absorbs all pre-PR spend
 *   window_i  = [pr_{i-1}.ts,  pr_i.ts)  — each later PR gets tokens since prev
 *   overhead  = [pr_k.ts, ∞)             — tokens after the last PR
 *
 * If any timestamp fails to parse, or sorted token timestamps are
 * non-monotonic, falls back to session-only attribution (no per-PR split).
 *
 * Multiple PRs at the same timestamp split window tokens evenly and set
 * tokensAttributed: "approximate".
 */
export function windowSession(input: WindowSessionInput): WindowSessionResult {
  const { sessionId, project, sessionStart, sessionEnd, prs, tokens } = input;

  const startMs = parseTs(sessionStart);
  const endMs = sessionEnd != null ? parseTs(sessionEnd) : null;
  const durationMs =
    startMs != null && endMs != null ? Math.max(0, endMs - startMs) : 0;

  const sessionBreakdown = sumBreakdowns(tokens.map((t) => t.tokens));
  const sessionSidechain = sumBreakdowns(
    tokens.filter((t) => t.isSidechain === true).map((t) => t.tokens),
  );
  const sessionModels = uniqueModels(tokens);

  const buildSession = (
    attributed: "windowed" | "session-only" | "approximate",
  ): SessionStats => ({
    sessionId,
    project,
    durationMs,
    prCount: prs.length,
    tokens: sessionBreakdown,
    sidechainTokens: sessionSidechain,
    models: sessionModels,
    outputShare: calcOutputShare(sessionBreakdown),
    cacheHitRatio: calcCacheHitRatio(sessionBreakdown),
    tokensPerActiveMinute:
      durationMs > 0
        ? sessionBreakdown.totalTokens / (durationMs / 60_000)
        : null,
    tokensAttributed: attributed,
  });

  // Dry session — no PRs; all tokens are dry spend.
  if (prs.length === 0) {
    return {
      session: buildSession("windowed"),
      perPR: [],
      overhead: zeroBreakdown(),
      overheadSidechain: zeroBreakdown(),
      isDrySession: true,
    };
  }

  // Can't window without a parseable session start.
  if (startMs === null) {
    return {
      session: buildSession("session-only"),
      perPR: [],
      overhead: zeroBreakdown(),
      overheadSidechain: zeroBreakdown(),
      isDrySession: false,
    };
  }

  // Parse and validate PR timestamps.
  const prsWithMs = prs.map((pr) => ({ ...pr, tsMs: parseTs(pr.prTimestamp) }));
  if (prsWithMs.some((pr) => pr.tsMs === null)) {
    return {
      session: buildSession("session-only"),
      perPR: [],
      overhead: zeroBreakdown(),
      overheadSidechain: zeroBreakdown(),
      isDrySession: false,
    };
  }
  const sortedPrs = [...prsWithMs].sort((a, b) => a.tsMs! - b.tsMs!);

  // Parse and validate token timestamps.
  const tokensWithMs = tokens.map((t) => ({
    ...t,
    tsMs: parseTs(t.timestamp),
  }));
  if (tokensWithMs.some((t) => t.tsMs === null)) {
    return {
      session: buildSession("session-only"),
      perPR: [],
      overhead: zeroBreakdown(),
      overheadSidechain: zeroBreakdown(),
      isDrySession: false,
    };
  }
  const sortedTokens = [...tokensWithMs].sort((a, b) => a.tsMs! - b.tsMs!);

  // Verify monotonicity after sort (guards against corrupt sort due to clock skew).
  for (let i = 1; i < sortedTokens.length; i++) {
    if (sortedTokens[i]!.tsMs! < sortedTokens[i - 1]!.tsMs!) {
      return {
        session: buildSession("session-only"),
        perPR: [],
        overhead: zeroBreakdown(),
        overheadSidechain: zeroBreakdown(),
        isDrySession: false,
      };
    }
  }

  const hasSameTsGroup = sortedPrs.some(
    (pr, i) => i > 0 && pr.tsMs === sortedPrs[i - 1]!.tsMs,
  );
  const globalAttributed: "windowed" | "approximate" = hasSameTsGroup
    ? "approximate"
    : "windowed";

  const perPR: PRWindowResult[] = [];
  let windowStartMs = startMs;
  let prevPrMs: number | null = null;

  for (let i = 0; i < sortedPrs.length; ) {
    // Collect all PRs that share the same timestamp into one group.
    const groupTs = sortedPrs[i]!.tsMs!;
    let j = i;
    while (j < sortedPrs.length && sortedPrs[j]!.tsMs === groupTs) {
      j++;
    }
    const group = sortedPrs.slice(i, j);
    const groupSize = group.length;

    // Tokens in [windowStartMs, groupTs) — token at exactly groupTs is next window.
    const windowEvents = sortedTokens.filter(
      (t) => t.tsMs! >= windowStartMs && t.tsMs! < groupTs,
    );
    const windowBreakdown = sumBreakdowns(windowEvents.map((t) => t.tokens));
    const windowSidechain = sumBreakdowns(
      windowEvents.filter((t) => t.isSidechain === true).map((t) => t.tokens),
    );
    const windowModels = uniqueModels(windowEvents);
    const usageMissing =
      windowEvents.length > 0 && windowEvents.every((t) => t.usageMissing);

    const msToPR = groupTs - windowStartMs;
    const msFromPrevPR = prevPrMs !== null ? groupTs - prevPrMs : null;

    for (const pr of group) {
      perPR.push({
        prUrl: pr.prUrl,
        prTimestamp: pr.prTimestamp,
        // Evenly split window tokens across same-timestamp PRs.
        tokens:
          groupSize === 1
            ? windowBreakdown
            : scaleBreakdown(windowBreakdown, 1 / groupSize),
        sidechainTokens:
          groupSize === 1
            ? windowSidechain
            : scaleBreakdown(windowSidechain, 1 / groupSize),
        msToPR,
        msFromPrevPR,
        models: windowModels,
        tokensAttributed: groupSize > 1 ? "approximate" : "windowed",
        usageMissing,
      });
    }

    prevPrMs = groupTs;
    windowStartMs = groupTs;
    i = j;
  }

  // Overhead: tokens at or after the last PR's timestamp.
  const lastPrMs = sortedPrs[sortedPrs.length - 1]!.tsMs!;
  const overheadEvents = sortedTokens.filter((t) => t.tsMs! >= lastPrMs);
  const overhead = sumBreakdowns(overheadEvents.map((t) => t.tokens));
  const overheadSidechain = sumBreakdowns(
    overheadEvents.filter((t) => t.isSidechain === true).map((t) => t.tokens),
  );

  return {
    session: buildSession(globalAttributed),
    perPR,
    overhead,
    overheadSidechain,
    isDrySession: false,
  };
}

// ─── aggregateTokensByProject() ─────────────────────────────────────────────

/**
 * Roll up per-session window results into per-project efficiency metrics.
 *
 * - productiveTokens: sum of PR-window tokens from sessions with ≥1 PR.
 * - dryTokens: total tokens from sessions with 0 PRs.
 * - overheadTokens: tokens after the last PR in PR-shipping sessions.
 * - Session-only sessions (windowing failed) contribute all tokens to
 *   productiveTokens and their PRs to prCount.
 */
export function aggregateTokensByProject(
  sessionResults: WindowSessionResult[],
): Record<string, ProjectTokenStats> {
  interface Acc {
    productiveTokens: TokenBreakdown;
    dryTokens: TokenBreakdown;
    overheadTokens: TokenBreakdown;
    sidechainTokens: TokenBreakdown;
    prCount: number;
  }

  const byProject = new Map<string, Acc>();

  const getAcc = (project: string): Acc => {
    let acc = byProject.get(project);
    if (acc === undefined) {
      acc = {
        productiveTokens: zeroBreakdown(),
        dryTokens: zeroBreakdown(),
        overheadTokens: zeroBreakdown(),
        sidechainTokens: zeroBreakdown(),
        prCount: 0,
      };
      byProject.set(project, acc);
    }
    return acc;
  };

  for (const result of sessionResults) {
    const { session, perPR, overhead, isDrySession } = result;
    const acc = getAcc(session.project);

    acc.sidechainTokens = addBreakdowns(
      acc.sidechainTokens,
      session.sidechainTokens,
    );

    if (isDrySession) {
      acc.dryTokens = addBreakdowns(acc.dryTokens, session.tokens);
    } else if (session.tokensAttributed === "session-only") {
      // Windowing failed — attribute all session tokens to productive.
      acc.productiveTokens = addBreakdowns(
        acc.productiveTokens,
        session.tokens,
      );
      acc.prCount += session.prCount;
    } else {
      // Windowed or approximate — use per-PR window totals.
      const windowTokens = sumBreakdowns(perPR.map((pr) => pr.tokens));
      acc.productiveTokens = addBreakdowns(acc.productiveTokens, windowTokens);
      acc.overheadTokens = addBreakdowns(acc.overheadTokens, overhead);
      acc.prCount += perPR.length;
    }
  }

  const result: Record<string, ProjectTokenStats> = {};

  for (const [project, acc] of byProject) {
    const {
      productiveTokens,
      dryTokens,
      overheadTokens,
      sidechainTokens,
      prCount,
    } = acc;
    const totalTokens = addBreakdowns(
      addBreakdowns(productiveTokens, dryTokens),
      overheadTokens,
    );

    result[project] = {
      productiveTokens,
      dryTokens,
      overheadTokens,
      sidechainTokens,
      totalTokens,
      dryTokenShare:
        totalTokens.totalTokens > 0
          ? dryTokens.totalTokens / totalTokens.totalTokens
          : 0,
      tokensPerPR: prCount > 0 ? productiveTokens.totalTokens / prCount : null,
      prsPerMTok:
        totalTokens.totalTokens > 0
          ? prCount / (totalTokens.totalTokens / 1_000_000)
          : null,
      cacheHitRatio: calcCacheHitRatio(totalTokens),
      outputShare: calcOutputShare(totalTokens),
    };
  }

  return result;
}

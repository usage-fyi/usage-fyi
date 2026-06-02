import { readdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanClaudeCodeSession } from "./sources/claudeCode.js";
import { scanCodexSession } from "./sources/codex.js";
import { resolveProject } from "./projectResolver.js";
import {
  aggregate,
  windowSession,
  aggregateTokensByProject,
  type SessionStats,
  type ProjectTokenStats,
} from "./aggregate.js";
import { type TokenBreakdown, zeroBreakdown } from "./sources/tokenTypes.js";
import { loadPricingFn } from "../adapters/ccusage.js";

export type { SessionStats };

const execFileAsync = promisify(execFile);

export interface PREvent {
  prUrl: string; // https://github.com/owner/repo/pull/n
  prRepository: string; // owner/repo
  prNumber: number;
  sessionId: string;
  project: string; // canonical git root path
  source: "claude-code" | "codex";
  sessionStart: string; // ISO 8601
  prTimestamp: string; // ISO 8601
  sessionEnd: string; // ISO 8601
  msToFirstPR: number;
  msSessionTotal: number;
  // Token attribution fields (pr-stats/2)
  tokens: TokenBreakdown;
  tokensAttributed: "windowed" | "session-only" | "approximate";
  models: string[];
  estimatedCostUsd: number | null;
  /** ms from the immediately preceding PR; null for the first PR in the session. */
  msFromPrevPR: number | null;
}

export interface PRProjectStats {
  prCount: number;
  sessionCount: number; // sessions with ≥ 1 PR
  sessionsWithNoPR: number;
  medianMsToFirstPR: number | null;
  p90MsToFirstPR: number | null;
  // Token efficiency fields (pr-stats/2)
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
  estimatedCostUsd: number | null;
  pricingFlag?: "unknown-model" | "blended-rate";
}

export interface PRStatsReport {
  schema: "pr-stats/2";
  generatedAt: string;
  events: PREvent[];
  bySession: SessionStats[];
  byProject: Record<string, PRProjectStats>;
}

export interface AnalyzePRStatsOpts {
  claudeProjectsDir?: string; // default: ~/.claude/projects
  codexSessionsDir?: string; // default: ~/.codex/sessions
  gitRootResolver?: (cwd: string) => Promise<string | null>;
}

/**
 * Resolve a working directory to its canonical project root.
 *
 * For a linked git worktree (e.g. `.harness/worktrees/iter-N`,
 * `.claude/worktrees/agent-…`), `git rev-parse --show-toplevel` returns the
 * worktree's *own* top-level directory, not the main repo — so using it alone
 * makes every worktree look like a separate project. `--git-common-dir`, by
 * contrast, points at the *shared* `.git` directory of the main repo and is
 * identical for the main worktree and all of its linked worktrees. Collapsing
 * to the parent of that `.git` yields a single canonical root per repository.
 *
 * Falls back to `--show-toplevel` when the common dir is not a plain `.git`
 * directory (bare repos, `--separate-git-dir`, submodules with a gitfile),
 * where the parent-of-`.git` heuristic would be wrong.
 */
export async function defaultGitRootResolver(
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ],
      { cwd },
    );
    const [topLevel = "", commonDir = ""] = stdout.trim().split("\n");
    const trimmedCommon = commonDir.replace(/\/+$/, "");
    if (/(^|\/)\.git$/.test(trimmedCommon)) {
      return dirname(trimmedCommon);
    }
    const trimmedTop = topLevel.replace(/\/+$/, "");
    return trimmedTop || null;
  } catch {
    return null;
  }
}

async function* findJsonlFiles(dir: string): AsyncGenerator<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* findJsonlFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        yield fullPath;
      }
    }
  } catch {
    // Directory does not exist or is inaccessible — silently skip.
  }
}

function formatMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60)
    return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (remMinutes === 0 && remSeconds === 0) return `${hours}h`;
  if (remSeconds === 0) return `${hours}h ${remMinutes}m`;
  return `${hours}h ${remMinutes}m ${remSeconds}s`;
}

/** Build a human-readable table from a PRStatsReport. */
export function formatPRStatsTable(report: PRStatsReport): string {
  const projects = Object.entries(report.byProject);
  if (projects.length === 0) {
    return "No PR stats found.";
  }

  projects.sort(([a], [b]) => a.localeCompare(b));

  const headers = ["Project", "PRs", "Median TTP", "P90 TTP"];
  const rows = projects.map(([project, stats]) => [
    project,
    String(stats.prCount),
    stats.medianMsToFirstPR === null ? "-" : formatMs(stats.medianMsToFirstPR),
    stats.p90MsToFirstPR === null ? "-" : formatMs(stats.p90MsToFirstPR),
  ]);

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );

  const formatRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(colWidths[i]! + 2)).join("");

  const lines: string[] = [];
  lines.push(formatRow(headers));
  lines.push(formatRow(headers.map((h) => "-".repeat(h.length))));
  for (const row of rows) lines.push(formatRow(row));

  return lines.join("\n");
}

interface SessionData {
  sessionId: string;
  project: string;
  sessionStart: string;
  sessionEnd: string | null;
  source: "claude-code" | "codex";
  rawPrEntries: Array<{
    prUrl: string;
    prNumber: number;
    prRepository: string;
    timestamp: string;
    sessionId: string;
  }>;
  tokens: import("./sources/tokenTypes.js").TokenEvent[];
}

const emptyTokenStats: ProjectTokenStats = {
  productiveTokens: zeroBreakdown(),
  dryTokens: zeroBreakdown(),
  overheadTokens: zeroBreakdown(),
  sidechainTokens: zeroBreakdown(),
  totalTokens: zeroBreakdown(),
  dryTokenShare: 0,
  tokensPerPR: null,
  prsPerMTok: null,
  cacheHitRatio: null,
  outputShare: null,
  estimatedCostUsd: null,
};

/**
 * Discover Claude Code and Codex session files, scan them, resolve projects,
 * and aggregate into a PRStatsReport.
 *
 * Determinism guarantees:
 * - `events` sorted by (project, prTimestamp, prUrl).
 * - `bySession` sorted by (project, sessionId).
 * - `byProject` keys sorted lexicographically (insertion order = sort order).
 */
export async function analyzePRStats(
  opts: AnalyzePRStatsOpts = {},
): Promise<PRStatsReport> {
  const home = os.homedir();
  const claudeDir = opts.claudeProjectsDir ?? join(home, ".claude", "projects");
  const codexDir = opts.codexSessionsDir ?? join(home, ".codex", "sessions");
  const gitRootResolver = opts.gitRootResolver ?? defaultGitRootResolver;

  const pricingFn = await loadPricingFn();

  const sessionDataList: SessionData[] = [];

  // ─── Claude Code ──────────────────────────────────────────────────────────
  for await (const filePath of findJsonlFiles(claudeDir)) {
    const result = await scanClaudeCodeSession(filePath);
    if (!result.cwd || !result.sessionStart) continue;

    const projectResult = await resolveProject(result.cwd, { gitRootResolver });
    if (!projectResult) continue;

    sessionDataList.push({
      sessionId: result.sessionId ?? basename(filePath),
      project: projectResult.gitRoot,
      sessionStart: result.sessionStart,
      sessionEnd: result.sessionEnd,
      source: "claude-code",
      rawPrEntries: result.rawPrEntries,
      tokens: result.tokens,
    });
  }

  // ─── Codex ────────────────────────────────────────────────────────────────
  for await (const filePath of findJsonlFiles(codexDir)) {
    const result = await scanCodexSession(filePath);
    if (!result.cwd || !result.sessionStart) continue;

    const projectResult = await resolveProject(result.cwd, { gitRootResolver });
    if (!projectResult) continue;

    sessionDataList.push({
      sessionId: result.sessionId ?? basename(filePath),
      project: projectResult.gitRoot,
      sessionStart: result.sessionStart,
      sessionEnd: result.sessionEnd,
      source: "codex",
      rawPrEntries: result.rawPrEntries,
      tokens: result.tokens,
    });
  }

  // ─── Window sessions ──────────────────────────────────────────────────────
  const windowResults = sessionDataList.map((sd) =>
    windowSession({
      sessionId: sd.sessionId,
      project: sd.project,
      sessionStart: sd.sessionStart,
      sessionEnd: sd.sessionEnd ?? null,
      prs: sd.rawPrEntries.map((e) => ({
        prUrl: e.prUrl,
        prTimestamp: e.timestamp,
      })),
      tokens: sd.tokens,
      pricingFn,
    }),
  );

  // ─── Build events ─────────────────────────────────────────────────────────
  const events: PREvent[] = [];

  for (let i = 0; i < sessionDataList.length; i++) {
    const sd = sessionDataList[i]!;
    const wr = windowResults[i]!;

    // Index window results by prUrl for O(1) lookup.
    const windowByPrUrl = new Map(wr.perPR.map((pr) => [pr.prUrl, pr]));

    for (const entry of sd.rawPrEntries) {
      const w = windowByPrUrl.get(entry.prUrl);
      const msToFirstPR = Math.max(
        0,
        new Date(entry.timestamp).getTime() -
          new Date(sd.sessionStart).getTime(),
      );
      const msSessionTotal = sd.sessionEnd
        ? Math.max(
            0,
            new Date(sd.sessionEnd).getTime() -
              new Date(sd.sessionStart).getTime(),
          )
        : 0;

      events.push({
        prUrl: entry.prUrl,
        prRepository: entry.prRepository,
        prNumber: entry.prNumber,
        sessionId: entry.sessionId,
        project: sd.project,
        source: sd.source,
        sessionStart: sd.sessionStart,
        prTimestamp: entry.timestamp,
        sessionEnd: sd.sessionEnd ?? sd.sessionStart,
        msToFirstPR,
        msSessionTotal,
        tokens: w?.tokens ?? zeroBreakdown(),
        tokensAttributed: w?.tokensAttributed ?? "session-only",
        models: w?.models ?? [],
        estimatedCostUsd: w?.estimatedCostUsd ?? null,
        msFromPrevPR: w?.msFromPrevPR ?? null,
      });
    }
  }

  // Sort events deterministically: (project, prTimestamp, prUrl).
  events.sort((a, b) => {
    const p = a.project.localeCompare(b.project);
    if (p !== 0) return p;
    const t = a.prTimestamp.localeCompare(b.prTimestamp);
    if (t !== 0) return t;
    return a.prUrl.localeCompare(b.prUrl);
  });

  // ─── bySession ────────────────────────────────────────────────────────────
  // Sort deterministically: (project, sessionId).
  const bySession = windowResults
    .map((wr) => wr.session)
    .sort((a, b) => {
      const p = a.project.localeCompare(b.project);
      if (p !== 0) return p;
      return a.sessionId.localeCompare(b.sessionId);
    });

  // ─── byProject ────────────────────────────────────────────────────────────
  // Latency stats from aggregate().
  const sessionMetas = sessionDataList.map((sd) => ({
    project: sd.project,
    sessionId: sd.sessionId,
    startedAt: sd.sessionStart,
  }));
  const prAggEvents = events.map((e) => ({
    project: e.project,
    sessionId: e.sessionId,
    createdAt: e.prTimestamp,
  }));
  const agg = aggregate(prAggEvents, sessionMetas);

  // Token stats from aggregateTokensByProject().
  const tokenStats = aggregateTokensByProject(windowResults);

  // Merge: keys sorted lexicographically so JSON output is deterministic.
  const allProjectKeys = new Set([
    ...Object.keys(agg.byProject),
    ...Object.keys(tokenStats),
  ]);
  const sortedProjectKeys = [...allProjectKeys].sort();

  const byProject: Record<string, PRProjectStats> = {};
  for (const project of sortedProjectKeys) {
    const latency = agg.byProject[project];
    const ts = tokenStats[project] ?? emptyTokenStats;

    byProject[project] = {
      prCount: latency?.prCount ?? 0,
      sessionCount: latency?.sessionCount ?? 0,
      sessionsWithNoPR: latency?.sessionsWithNoPR ?? 0,
      medianMsToFirstPR: latency?.medianMsToFirstPR ?? null,
      p90MsToFirstPR: latency?.p90MsToFirstPR ?? null,
      productiveTokens: ts.productiveTokens,
      dryTokens: ts.dryTokens,
      overheadTokens: ts.overheadTokens,
      sidechainTokens: ts.sidechainTokens,
      totalTokens: ts.totalTokens,
      dryTokenShare: ts.dryTokenShare,
      tokensPerPR: ts.tokensPerPR,
      prsPerMTok: ts.prsPerMTok,
      cacheHitRatio: ts.cacheHitRatio,
      outputShare: ts.outputShare,
      estimatedCostUsd: ts.estimatedCostUsd,
      ...(ts.pricingFlag !== undefined ? { pricingFlag: ts.pricingFlag } : {}),
    };
  }

  return {
    schema: "pr-stats/2",
    generatedAt: new Date().toISOString(),
    events,
    bySession,
    byProject,
  };
}

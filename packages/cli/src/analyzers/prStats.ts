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
  type WindowSessionResult,
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
  since?: string; // ISO or yyyy-mm-dd — filter events to prTimestamp >= since
  project?: string; // canonical project path — filter to this project
  pr?: string; // PR URL, "#N", or "N" — filter to a single PR
}

export interface FormatTableOpts {
  by?: "event" | "session";
  pr?: string | null;
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

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtCost(usd: number | null): string {
  if (usd === null) return "—";
  return `$${usd.toFixed(2)}`;
}

function fmtPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function buildTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const formatRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(colWidths[i]! + 2)).join("").trimEnd();
  const lines: string[] = [];
  lines.push(formatRow(headers));
  lines.push(formatRow(headers.map((h) => "-".repeat(h.length))));
  for (const row of rows) lines.push(formatRow(row));
  return lines.join("\n");
}

function formatByProject(report: PRStatsReport): string {
  const projects = Object.entries(report.byProject);
  if (projects.length === 0) return "No PR stats found.";

  projects.sort(([a], [b]) => a.localeCompare(b));

  // Collect unique models per project from events
  const modelsByProject = new Map<string, Set<string>>();
  for (const event of report.events) {
    if (!modelsByProject.has(event.project)) {
      modelsByProject.set(event.project, new Set());
    }
    for (const m of event.models) {
      modelsByProject.get(event.project)!.add(m);
    }
  }

  const headers = [
    "Project",
    "PRs",
    "Median TTP",
    "P90 TTP",
    "Tokens",
    "Cost",
    "Model(s)",
    "Dry%",
  ];
  const rows = projects.map(([project, stats]) => [
    project,
    String(stats.prCount),
    stats.medianMsToFirstPR === null
      ? "—"
      : formatMs(stats.medianMsToFirstPR),
    stats.p90MsToFirstPR === null ? "—" : formatMs(stats.p90MsToFirstPR),
    fmtTokens(stats.totalTokens.totalTokens),
    fmtCost(stats.estimatedCostUsd),
    [...(modelsByProject.get(project) ?? [])].sort().join(", ") || "—",
    fmtPercent(stats.dryTokenShare),
  ]);

  return buildTable(headers, rows);
}

function formatBySession(report: PRStatsReport): string {
  if (report.bySession.length === 0) return "No sessions found.";

  const sessions = [...report.bySession].sort((a, b) => {
    const p = a.project.localeCompare(b.project);
    if (p !== 0) return p;
    return a.sessionId.localeCompare(b.sessionId);
  });

  const headers = ["Project", "Session", "Duration", "PRs", "Tokens", "Cost"];
  const rows = sessions.map((s) => [
    s.project,
    s.sessionId.slice(0, 16),
    formatMs(s.durationMs),
    String(s.prCount),
    fmtTokens(s.tokens.totalTokens),
    fmtCost(s.estimatedCostUsd),
  ]);

  return buildTable(headers, rows);
}

function formatPRDetail(report: PRStatsReport): string {
  if (report.events.length === 0) return "No PR found matching filter.";

  const event = report.events[0]!;
  const t = event.tokens;
  const cacheHit =
    t.inputTokens + t.cacheReadTokens > 0
      ? t.cacheReadTokens / (t.inputTokens + t.cacheReadTokens)
      : null;

  return [
    `PR:              ${event.prUrl}`,
    `Project:         ${event.project}`,
    "",
    "Tokens",
    `  Input:         ${fmtTokens(t.inputTokens)}`,
    `  Output:        ${fmtTokens(t.outputTokens)}`,
    `  Cache read:    ${fmtTokens(t.cacheReadTokens)}`,
    `  Cache write:   ${fmtTokens(t.cacheCreationTokens)}`,
    `  Total:         ${fmtTokens(t.totalTokens)}`,
    "",
    "Performance",
    `  Time to PR:    ${formatMs(event.msToFirstPR)}`,
    `  Since prev PR: ${event.msFromPrevPR === null ? "—" : formatMs(event.msFromPrevPR)}`,
    `  Cache hit:     ${cacheHit === null ? "—" : fmtPercent(cacheHit)}`,
    `  Cost:          ${fmtCost(event.estimatedCostUsd)}`,
    "",
    `Models:          ${event.models.join(", ") || "—"}`,
  ].join("\n");
}

/** Build a human-readable table from a PRStatsReport. */
export function formatPRStatsTable(
  report: PRStatsReport,
  opts: FormatTableOpts = {},
): string {
  if (opts.pr != null) {
    return formatPRDetail(report);
  }
  if (opts.by === "session") {
    return formatBySession(report);
  }
  return formatByProject(report);
}

// ─── PR filter matcher ────────────────────────────────────────────────────────

function buildPrMatcher(pr: string): (event: PREvent) => boolean {
  if (pr.startsWith("http://") || pr.startsWith("https://")) {
    return (e) => e.prUrl === pr;
  }
  const numMatch = /^#?(\d+)$/.exec(pr);
  if (numMatch) {
    const num = parseInt(numMatch[1]!, 10);
    return (e) => e.prNumber === num;
  }
  // Try last path segment (e.g. partial URL)
  const segments = pr.split("/").filter(Boolean);
  const lastSeg = segments[segments.length - 1];
  const segNum = lastSeg ? parseInt(lastSeg, 10) : NaN;
  if (!isNaN(segNum)) {
    return (e) => e.prNumber === segNum;
  }
  return (e) => e.prUrl === pr;
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
 *
 * Filtering (opts.since / opts.project / opts.pr) is applied after building all
 * events so byProject reflects only the scoped window.
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
  const windowResults: WindowSessionResult[] = sessionDataList.map((sd) =>
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

  // ─── Apply project filter (session-level) ─────────────────────────────────
  let activeIndices = sessionDataList.map((_, i) => i);
  if (opts.project) {
    const projectFilter = opts.project;
    activeIndices = activeIndices.filter(
      (i) => sessionDataList[i]!.project === projectFilter,
    );
  }

  // ─── Build events from active sessions ────────────────────────────────────
  let events: PREvent[] = [];

  for (const idx of activeIndices) {
    const sd = sessionDataList[idx]!;
    const wr = windowResults[idx]!;

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

  // ─── Apply since filter ───────────────────────────────────────────────────
  if (opts.since) {
    const sinceMs = new Date(opts.since).getTime();
    if (!isNaN(sinceMs)) {
      events = events.filter(
        (e) => new Date(e.prTimestamp).getTime() >= sinceMs,
      );
      const sessionIdsWithEvent = new Set(events.map((e) => e.sessionId));
      activeIndices = activeIndices.filter((i) => {
        const sd = sessionDataList[i]!;
        const wr = windowResults[i]!;
        return (
          sessionIdsWithEvent.has(sd.sessionId) ||
          (wr.isDrySession &&
            new Date(sd.sessionStart).getTime() >= sinceMs)
        );
      });
    }
  }

  // ─── Apply PR filter ──────────────────────────────────────────────────────
  if (opts.pr != null) {
    const matcher = buildPrMatcher(opts.pr);
    events = events.filter((e) => matcher(e));
    const projectsSet = new Set(events.map((e) => e.project));
    if (projectsSet.size > 1 && !opts.project) {
      throw new Error(
        `--pr "${opts.pr}" matches PRs in multiple projects: ${[...projectsSet].join(", ")}. Use --project to specify one.`,
      );
    }
    const sessionIdsWithEvent = new Set(events.map((e) => e.sessionId));
    activeIndices = activeIndices.filter((i) =>
      sessionIdsWithEvent.has(sessionDataList[i]!.sessionId),
    );
  }

  // Sort events deterministically: (project, prTimestamp, prUrl).
  events.sort((a, b) => {
    const p = a.project.localeCompare(b.project);
    if (p !== 0) return p;
    const t = a.prTimestamp.localeCompare(b.prTimestamp);
    if (t !== 0) return t;
    return a.prUrl.localeCompare(b.prUrl);
  });

  const activeWindowResults = activeIndices.map((i) => windowResults[i]!);
  const activeSessionData = activeIndices.map((i) => sessionDataList[i]!);

  // ─── bySession ────────────────────────────────────────────────────────────
  const bySession = activeWindowResults
    .map((wr) => wr.session)
    .sort((a, b) => {
      const p = a.project.localeCompare(b.project);
      if (p !== 0) return p;
      return a.sessionId.localeCompare(b.sessionId);
    });

  // ─── byProject ────────────────────────────────────────────────────────────
  const sessionMetas = activeSessionData.map((sd) => ({
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

  const tokenStats = aggregateTokensByProject(activeWindowResults);

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

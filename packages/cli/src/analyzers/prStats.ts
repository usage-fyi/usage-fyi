import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanClaudeCodeSession } from "./sources/claudeCode.js";
import { scanCodexSession } from "./sources/codex.js";
import { resolveProject } from "./projectResolver.js";
import { aggregate } from "./aggregate.js";

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
}

export interface PRProjectStats {
  prCount: number;
  sessionCount: number; // sessions with ≥ 1 PR
  sessionsWithNoPR: number;
  medianMsToFirstPR: number | null;
  p90MsToFirstPR: number | null;
}

export interface PRStatsReport {
  schema: "pr-stats/1";
  generatedAt: string;
  events: PREvent[];
  byProject: Record<string, PRProjectStats>;
}

export interface AnalyzePRStatsOpts {
  claudeProjectsDir?: string; // default: ~/.claude/projects
  codexSessionsDir?: string; // default: ~/.codex/sessions
  gitRootResolver?: (cwd: string) => Promise<string | null>;
}

async function defaultGitRootResolver(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd },
    );
    const trimmed = stdout.trim();
    return trimmed || null;
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
  if (minutes < 60) return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
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

/**
 * Discover Claude Code and Codex session files, scan them, resolve projects,
 * and aggregate into a PRStatsReport.
 */
export async function analyzePRStats(
  opts: AnalyzePRStatsOpts = {},
): Promise<PRStatsReport> {
  const home = os.homedir();
  const claudeDir = opts.claudeProjectsDir ?? join(home, ".claude", "projects");
  const codexDir = opts.codexSessionsDir ?? join(home, ".codex", "sessions");
  const gitRootResolver = opts.gitRootResolver ?? defaultGitRootResolver;

  const events: PREvent[] = [];
  const sessionMetas: Array<{
    project: string;
    sessionId: string;
    startedAt: string;
  }> = [];

  // ─── Claude Code ──────────────────────────────────────────────────────────
  for await (const filePath of findJsonlFiles(claudeDir)) {
    const result = await scanClaudeCodeSession(filePath);
    if (!result.cwd || !result.sessionStart) continue;

    const projectResult = await resolveProject(result.cwd, { gitRootResolver });
    if (!projectResult) continue;

    const project = projectResult.gitRoot;
    sessionMetas.push({
      project,
      sessionId: result.sessionId ?? basename(result.filePath),
      startedAt: result.sessionStart,
    });

    for (const entry of result.rawPrEntries) {
      const msToFirstPR = Math.max(
        0,
        new Date(entry.timestamp).getTime() - new Date(result.sessionStart).getTime(),
      );
      const msSessionTotal = result.sessionEnd
        ? Math.max(0, new Date(result.sessionEnd).getTime() - new Date(result.sessionStart).getTime())
        : 0;

      events.push({
        prUrl: entry.prUrl,
        prRepository: entry.prRepository,
        prNumber: entry.prNumber,
        sessionId: entry.sessionId,
        project,
        source: "claude-code",
        sessionStart: result.sessionStart,
        prTimestamp: entry.timestamp,
        sessionEnd: result.sessionEnd ?? result.sessionStart,
        msToFirstPR,
        msSessionTotal,
      });
    }
  }

  // ─── Codex ────────────────────────────────────────────────────────────────
  for await (const filePath of findJsonlFiles(codexDir)) {
    const result = await scanCodexSession(filePath);
    if (!result.cwd || !result.sessionStart) continue;

    const projectResult = await resolveProject(result.cwd, { gitRootResolver });
    if (!projectResult) continue;

    const project = projectResult.gitRoot;
    sessionMetas.push({
      project,
      sessionId: result.sessionId ?? basename(result.filePath),
      startedAt: result.sessionStart,
    });

    for (const entry of result.rawPrEntries) {
      const msToFirstPR = Math.max(
        0,
        new Date(entry.timestamp).getTime() - new Date(result.sessionStart).getTime(),
      );
      const msSessionTotal = result.sessionEnd
        ? Math.max(0, new Date(result.sessionEnd).getTime() - new Date(result.sessionStart).getTime())
        : 0;

      events.push({
        prUrl: entry.prUrl,
        prRepository: entry.prRepository,
        prNumber: entry.prNumber,
        sessionId: entry.sessionId,
        project,
        source: "codex",
        sessionStart: result.sessionStart,
        prTimestamp: entry.timestamp,
        sessionEnd: result.sessionEnd ?? result.sessionStart,
        msToFirstPR,
        msSessionTotal,
      });
    }
  }

  const agg = aggregate(
    events.map((e) => ({
      project: e.project,
      sessionId: e.sessionId,
      createdAt: e.prTimestamp,
    })),
    sessionMetas,
  );

  const byProject: Record<string, PRProjectStats> = {};
  for (const [project, stats] of Object.entries(agg.byProject)) {
    byProject[project] = stats;
  }

  return {
    schema: "pr-stats/1",
    generatedAt: new Date().toISOString(),
    events,
    byProject,
  };
}

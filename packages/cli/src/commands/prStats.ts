import {
  analyzePRStats,
  formatPRStatsTable,
  type AnalyzePRStatsOpts,
} from "../analyzers/index.js";

export interface RunPrStatsOpts {
  json: boolean;
  by?: "event" | "session";
  pr?: string | null;
  since?: string | null;
  project?: string | null;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  gitRootResolver?: (cwd: string) => Promise<string | null>;
}

export async function runPrStats(opts: RunPrStatsOpts): Promise<number> {
  const analyzeOpts: AnalyzePRStatsOpts = {};
  if (opts.claudeProjectsDir !== undefined) {
    analyzeOpts.claudeProjectsDir = opts.claudeProjectsDir;
  }
  if (opts.codexSessionsDir !== undefined) {
    analyzeOpts.codexSessionsDir = opts.codexSessionsDir;
  }
  if (opts.gitRootResolver !== undefined) {
    analyzeOpts.gitRootResolver = opts.gitRootResolver;
  }
  if (opts.since != null) {
    analyzeOpts.since = opts.since;
  }
  if (opts.project != null) {
    analyzeOpts.project = opts.project;
  }
  if (opts.pr != null) {
    analyzeOpts.pr = opts.pr;
  }

  let report;
  try {
    report = await analyzePRStats(analyzeOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      formatPRStatsTable(report, {
        by: opts.by ?? "event",
        pr: opts.pr ?? null,
      }),
    );
  }

  return 0;
}

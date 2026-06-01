import {
  analyzePRStats,
  formatPRStatsTable,
  type AnalyzePRStatsOpts,
} from "../analyzers/index.js";

export interface RunPrStatsOpts {
  json: boolean;
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
  const report = await analyzePRStats(analyzeOpts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatPRStatsTable(report));
  }

  return 0;
}

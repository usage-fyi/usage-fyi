import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { slim, type RawCcusage, type RawAgentDaily } from "../core/index.js";
import type { UsageAdapter, CollectOpts } from "./types.js";

// ─── Pricing types ────────────────────────────────────────────────────────────

export interface PricingResult {
  usd: number | null;
  flag?: "unknown-model" | "blended-rate";
}

/**
 * Synchronous pricing function returned by loadPricingFn().
 * Accepts a model id and total token count; returns USD cost or null.
 */
export type SyncPricingFn = (
  model: string,
  totalTokens: number,
) => PricingResult;

export class CollectError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = "CollectError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

const AVAILABLE_TIMEOUT_MS = 5_000;
const COLLECT_TIMEOUT_MS = 30_000;

/**
 * Resolve the absolute path to ccusage's JS bin file via Node module resolution.
 * Works under both Node and Bun (both honor `import.meta.resolve` and the
 * ccusage package's `bin` mapping) — no PATH or bunx dependency.
 */
function resolveCcusageBin(): string {
  const pkgUrl = import.meta.resolve("ccusage/package.json");
  const pkgPath = fileURLToPath(pkgUrl);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.ccusage;
  if (!binRel) {
    throw new Error("ccusage package has no `ccusage` bin entry");
  }
  return join(dirname(pkgPath), binRel);
}

/** Parse/validate subprocess output; exported for unit testing without spawning. */
export function parseCollectOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): RawCcusage {
  if (exitCode !== 0) {
    throw new CollectError(
      `ccusage exited with code ${exitCode}`,
      stderr,
      exitCode,
    );
  }
  if (stdout.trim() === "") {
    throw new CollectError("ccusage produced no output", stderr, exitCode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CollectError(
      "ccusage output was not valid JSON",
      stderr,
      exitCode,
    );
  }
  return parsed as RawCcusage;
}

/**
 * Parse one per-agent subcommand JSON. These schemas vary across agents
 * (claude/gemini/kimi/qwen/pi share one shape; codex uses a different one),
 * but we only need to extract (date, model) attribution from them — never
 * numbers — so a lenient cast is enough. On any parse failure we return an
 * empty payload so the attribution lookup falls back to prefix inference
 * rather than blowing up the whole publish.
 */
function parseAgentOutput(stdout: string, exitCode: number): RawAgentDaily {
  if (exitCode !== 0 || stdout.trim() === "") return { daily: [] };
  try {
    return JSON.parse(stdout) as RawAgentDaily;
  } catch {
    return { daily: [] };
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn ccusage under the current runtime (`process.execPath` is `node` on
 * Node and `bun` on Bun). Times out via `proc.kill()` after `timeoutMs`.
 */
async function runCcusage(
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  const proc = spawn(process.execPath, [resolveCcusageBin(), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const killTimer = setTimeout(() => proc.kill(), timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      new Promise<number>((resolve, reject) => {
        proc.once("exit", (code) => resolve(code ?? 0));
        proc.once("error", reject);
      }),
      text(proc.stdout),
      text(proc.stderr),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killTimer);
  }
}

// ─── Pricing adapter ─────────────────────────────────────────────────────────

interface DailyRow {
  modelsUsed?: string[];
  totalTokens: number;
  totalCost: number;
}

/**
 * Strip the trailing -YYYYMMDD date suffix from a model id so that
 * "claude-opus-4-8-20260301" and "claude-opus-4-8" resolve to the same key.
 */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/**
 * Build a model → effective $/token rate map from ccusage daily rows.
 *
 * For rows with a single model the rate is exact; for multi-model rows the
 * row's blended rate (totalCost / totalTokens) is assigned to each model in
 * that row. When a model appears in multiple rows the rates are combined as a
 * weighted average. The "blended-rate" flag on pricing results documents this
 * limitation to consumers.
 *
 * Exported for unit testing without spawning the subprocess.
 */
export function buildRateMap(rows: DailyRow[]): Map<string, number> {
  const acc = new Map<string, { cost: number; tokens: number }>();
  for (const row of rows) {
    if (row.totalTokens <= 0) continue;
    for (const model of row.modelsUsed ?? []) {
      if (!model) continue;
      const key = normalizeModelId(model);
      const entry = acc.get(key);
      if (entry) {
        entry.cost += row.totalCost;
        entry.tokens += row.totalTokens;
      } else {
        acc.set(key, { cost: row.totalCost, tokens: row.totalTokens });
      }
    }
  }
  const map = new Map<string, number>();
  for (const [model, { cost, tokens }] of acc) {
    if (tokens > 0) map.set(model, cost / tokens);
  }
  return map;
}

/** Create a synchronous pricing function from a pre-built rate map. */
export function makePricingFn(rateMap: Map<string, number>): SyncPricingFn {
  return (model: string, totalTokens: number): PricingResult => {
    const key = normalizeModelId(model);
    const rate = rateMap.get(key) ?? rateMap.get(model);
    if (rate === undefined) return { usd: null, flag: "unknown-model" };
    return { usd: rate * totalTokens, flag: "blended-rate" };
  };
}

/**
 * Load the pricing function once and memoize it for the process lifetime.
 *
 * Runs `ccusage daily --json` (all history) to derive effective per-model
 * blended rates. Failures are non-fatal — an empty rate map is returned so
 * callers get `null` cost with `unknown-model` flag rather than a crash.
 */
let pricingFnPromise: Promise<SyncPricingFn> | null = null;

export function loadPricingFn(): Promise<SyncPricingFn> {
  if (pricingFnPromise) return pricingFnPromise;
  pricingFnPromise = (async (): Promise<SyncPricingFn> => {
    try {
      const { exitCode, stdout } = await runCcusage(
        ["daily", "--json"],
        COLLECT_TIMEOUT_MS,
      );
      if (exitCode !== 0 || stdout.trim() === "")
        return makePricingFn(new Map());
      const parsed = JSON.parse(stdout) as {
        daily?: DailyRow[];
      };
      return makePricingFn(buildRateMap(parsed.daily ?? []));
    } catch {
      return makePricingFn(new Map());
    }
  })();
  return pricingFnPromise;
}

/**
 * Subset of ccusage subcommands that map to a known harness agent id. The
 * unified `ccusage daily --json` tags each day's metadata.agents[] with
 * exactly these strings, so we use them as both the lookup key and the
 * subcommand to invoke. Any agent appearing in metadata.agents that is NOT
 * in this list falls through to name-prefix inference in slim().
 */
const KNOWN_AGENT_SUBCOMMANDS = new Set([
  "claude",
  "codex",
  "opencode",
  "amp",
  "droid",
  "codebuff",
  "hermes",
  "pi",
  "goose",
  "kilo",
  "copilot",
  "gemini",
  "kimi",
  "qwen",
  "openclaw",
]);

export const ccusageAdapter: UsageAdapter<RawCcusage> = {
  id: "ccusage",

  async available(): Promise<boolean> {
    try {
      const { exitCode } = await runCcusage(
        ["--version"],
        AVAILABLE_TIMEOUT_MS,
      );
      return exitCode === 0;
    } catch {
      return false;
    }
  },

  async collect(opts: CollectOpts): Promise<RawCcusage> {
    const rangeArgs: string[] = [];
    if (opts.from) rangeArgs.push("--since", opts.from);
    if (opts.to) rangeArgs.push("--until", opts.to);

    // 1) Unified daily — source of truth for per-(date, model) numbers.
    const unified = await runCcusage(
      ["daily", "--json", ...rangeArgs],
      COLLECT_TIMEOUT_MS,
    );
    const raw = parseCollectOutput(
      unified.stdout,
      unified.stderr,
      unified.exitCode,
    );

    // 2) Union of agents across the range (from unified daily's metadata).
    const agentSet = new Set<string>();
    for (const d of raw.daily ?? []) {
      for (const a of d.metadata?.agents ?? []) {
        if (KNOWN_AGENT_SUBCOMMANDS.has(a)) agentSet.add(a);
      }
    }

    // 3) For each agent, fetch its per-agent breakdown in parallel. Treat
    //    the numbers in these as informational only; we use them as a
    //    (date, model) → agent attribution lookup. Failures are non-fatal;
    //    a missing payload just falls back to prefix inference for that
    //    agent.
    const agents = [...agentSet].sort();
    const perAgentResults = await Promise.all(
      agents.map(async (agent) => {
        try {
          const { stdout, exitCode } = await runCcusage(
            [agent, "daily", "--json", ...rangeArgs],
            COLLECT_TIMEOUT_MS,
          );
          return [agent, parseAgentOutput(stdout, exitCode)] as const;
        } catch {
          return [agent, { daily: [] } satisfies RawAgentDaily] as const;
        }
      }),
    );

    const perAgent: Record<string, RawAgentDaily> = {};
    for (const [agent, payload] of perAgentResults) perAgent[agent] = payload;

    return { ...raw, perAgent };
  },

  toSnapshot(raw: RawCcusage) {
    return slim(raw, {
      origin: "tool-collected",
      generatedAt: new Date().toISOString(),
    });
  },
};

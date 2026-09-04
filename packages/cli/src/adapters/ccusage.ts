import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { slim, type RawCcusage, type RawAgentDaily } from "../core/index.js";
import type { UsageAdapter, CollectOpts } from "./types.js";

// ─── Pricing types ────────────────────────────────────────────────────────────

/**
 * How a cost estimate was produced.
 *
 *  - "modeled-rate"  — priced with per-token-type rates fitted to this
 *                      model's own ccusage history. Most accurate: input,
 *                      output, cache-creation and cache-read are charged at
 *                      their own rates.
 *  - "blended-rate"  — priced with a single $/token rate averaged over every
 *                      token type. Used when a model has too little history
 *                      to fit. Over-prices cache-heavy spend and
 *                      under-prices output-heavy spend.
 *  - "unknown-model" — the model never appears in ccusage's output, so no
 *                      rate could be derived at all.
 */
export type PricingFlag = "modeled-rate" | "blended-rate" | "unknown-model";

export interface PricingResult {
  usd: number | null;
  flag?: PricingFlag;
}

/** Per-token-type token counts a pricing call is made against. */
export interface PricedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Synchronous pricing function returned by loadPricingFn().
 * Accepts a model id and a per-token-type breakdown; returns USD cost or null.
 */
export type SyncPricingFn = (
  model: string,
  tokens: PricedTokens,
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
  modelBreakdowns?: {
    modelName: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    cost?: number;
  }[];
}

/**
 * Strip the trailing -YYYYMMDD date suffix from a model id so that
 * "claude-opus-4-8-20260301" and "claude-opus-4-8" resolve to the same key.
 */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** A model's price per token, split by token type. */
export interface RateVector {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** What we know about how to price one model. */
export type ModelRate =
  | { kind: "modeled"; rates: RateVector }
  | { kind: "blended"; perToken: number };

/**
 * Minimum number of (day, model) observations before we trust a fitted rate
 * vector. Four unknowns need meaningfully more than four rows to be
 * identifiable; below this we keep the blended scalar, which is coarse but
 * never wild.
 */
const MIN_FIT_OBSERVATIONS = 8;

/**
 * Sanity ceiling on a fitted rate, in USD per token. No real model costs
 * $1,000 per million tokens; anything above this means the fit was
 * degenerate (collinear inputs) and must be discarded.
 */
const MAX_PLAUSIBLE_RATE = 1_000 / 1_000_000;

/** One (day, model) observation: token counts and the cost ccusage assigned. */
interface Observation {
  x: [number, number, number, number];
  cost: number;
}

/**
 * Solve a small dense linear system by Gauss-Jordan elimination with partial
 * pivoting. Returns null when the matrix is singular.
 */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-18) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let k = col; k <= n; k++) m[r]![k]! -= f * m[col]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/**
 * Exact non-negative least squares for the four token-type rates.
 *
 * With only four unknowns the constrained optimum can be found by brute
 * force: every solution has some subset of the rates pinned at zero, so we
 * enumerate all sixteen subsets, solve the unconstrained problem on each,
 * keep the feasible ones (all coefficients >= 0) and return the one with the
 * lowest sum of squared errors. That is exact, deterministic and needs no
 * iteration count or convergence tolerance.
 *
 * Non-negativity matters: an unconstrained fit routinely returns negative
 * input rates because input and cache-read tokens are strongly correlated in
 * real usage, and a negative price per token is nonsense.
 *
 * Exported for unit testing.
 */
export function fitRateVector(obs: Observation[]): RateVector | null {
  const N = 4;
  const ata: number[][] = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => 0),
  );
  const aty: number[] = Array.from({ length: N }, () => 0);
  let yy = 0;
  for (const o of obs) {
    yy += o.cost * o.cost;
    for (let a = 0; a < N; a++) {
      aty[a]! += o.x[a]! * o.cost;
      for (let b = 0; b < N; b++) ata[a]![b]! += o.x[a]! * o.x[b]!;
    }
  }

  let best: number[] | null = null;
  let bestSse = Infinity;

  for (let mask = 0; mask < 1 << N; mask++) {
    const idx: number[] = [];
    for (let a = 0; a < N; a++) if (mask & (1 << a)) idx.push(a);

    const x: number[] = Array.from({ length: N }, () => 0);
    if (idx.length > 0) {
      const sub = idx.map((i) => idx.map((j) => ata[i]![j]!));
      const rhs = idx.map((i) => aty[i]!);
      // Tiny ridge term so exactly-collinear columns resolve deterministically
      // instead of tripping the singularity guard.
      let trace = 0;
      for (let k = 0; k < idx.length; k++) trace += sub[k]![k]!;
      for (let k = 0; k < idx.length; k++) sub[k]![k]! += trace * 1e-13;

      const sol = solveLinearSystem(sub, rhs);
      if (!sol) continue;
      let feasible = true;
      for (let k = 0; k < idx.length; k++) {
        if (sol[k]! < -1e-15) {
          feasible = false;
          break;
        }
        x[idx[k]!] = Math.max(0, sol[k]!);
      }
      if (!feasible) continue;
    }

    let sse = yy;
    for (let a = 0; a < N; a++) {
      sse -= 2 * x[a]! * aty[a]!;
      for (let b = 0; b < N; b++) sse += x[a]! * ata[a]![b]! * x[b]!;
    }
    if (sse < bestSse - 1e-12) {
      bestSse = sse;
      best = x;
    }
  }

  if (!best) return null;
  if (best.some((r) => !Number.isFinite(r) || r > MAX_PLAUSIBLE_RATE))
    return null;
  return {
    input: best[0]!,
    output: best[1]!,
    cacheCreation: best[2]!,
    cacheRead: best[3]!,
  };
}

/**
 * Build a model -> pricing rule table from ccusage daily rows.
 *
 * ccusage reports, for every (day, model), the exact token counts split by
 * type and the exact cost it computed. That is a system of linear equations
 * in the four unknown per-token-type rates, so for any model with enough
 * history we can recover the rates it was actually priced at -- including
 * the effect of pricing rules we cannot see (200k-context tiers,
 * cache-creation duration splits) averaged over that model's real usage.
 *
 * Models with too little history fall back to the previous behaviour: a
 * single blended $/token rate. That is coarse -- it prices a cache-read
 * token the same as an output token -- but it is bounded and never wild.
 *
 * Exported for unit testing without spawning the subprocess.
 */
export function buildRateTable(rows: DailyRow[]): Map<string, ModelRate> {
  const observations = new Map<string, Observation[]>();
  const blended = new Map<string, { cost: number; tokens: number }>();

  for (const row of rows) {
    const breakdowns = row.modelBreakdowns ?? [];
    if (breakdowns.length > 0) {
      for (const b of breakdowns) {
        if (!b?.modelName) continue;
        const key = normalizeModelId(b.modelName);
        const i = b.inputTokens ?? 0;
        const o = b.outputTokens ?? 0;
        const cc = b.cacheCreationTokens ?? 0;
        const cr = b.cacheReadTokens ?? 0;
        const total = i + o + cc + cr;
        if (total <= 0) continue;
        const cost = b.cost ?? 0;

        const list = observations.get(key);
        if (list) list.push({ x: [i, o, cc, cr], cost });
        else observations.set(key, [{ x: [i, o, cc, cr], cost }]);

        const acc = blended.get(key);
        if (acc) {
          acc.cost += cost;
          acc.tokens += total;
        } else {
          blended.set(key, { cost, tokens: total });
        }
      }
      continue;
    }

    // No per-model breakdown (older ccusage): fall back to the day's blended
    // rate assigned to every model on that day.
    if (row.totalTokens <= 0) continue;
    for (const model of row.modelsUsed ?? []) {
      if (!model) continue;
      const key = normalizeModelId(model);
      const acc = blended.get(key);
      if (acc) {
        acc.cost += row.totalCost;
        acc.tokens += row.totalTokens;
      } else {
        blended.set(key, { cost: row.totalCost, tokens: row.totalTokens });
      }
    }
  }

  const table = new Map<string, ModelRate>();
  for (const [model, acc] of blended) {
    const obs = observations.get(model) ?? [];
    if (obs.length >= MIN_FIT_OBSERVATIONS) {
      const rates = fitRateVector(obs);
      if (rates) {
        table.set(model, { kind: "modeled", rates });
        continue;
      }
    }
    if (acc.tokens > 0) {
      table.set(model, { kind: "blended", perToken: acc.cost / acc.tokens });
    }
  }
  return table;
}

/** Create a synchronous pricing function from a pre-built rate table. */
export function makePricingFn(table: Map<string, ModelRate>): SyncPricingFn {
  return (model: string, tokens: PricedTokens): PricingResult => {
    const key = normalizeModelId(model);
    const rate = table.get(key) ?? table.get(model);
    if (rate === undefined) return { usd: null, flag: "unknown-model" };

    if (rate.kind === "modeled") {
      const { rates } = rate;
      const usd =
        tokens.inputTokens * rates.input +
        tokens.outputTokens * rates.output +
        tokens.cacheCreationTokens * rates.cacheCreation +
        tokens.cacheReadTokens * rates.cacheRead;
      return { usd, flag: "modeled-rate" };
    }

    const total =
      tokens.inputTokens +
      tokens.outputTokens +
      tokens.cacheCreationTokens +
      tokens.cacheReadTokens;
    return { usd: rate.perToken * total, flag: "blended-rate" };
  };
}

/**
 * Load the pricing function once and memoize it for the process lifetime.
 *
 * Runs `ccusage daily --json` (all history) to recover per-model rates.
 * Failures are non-fatal -- an empty table is returned so callers get `null`
 * cost with the "unknown-model" flag rather than a crash.
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
      const parsed = JSON.parse(stdout) as { daily?: DailyRow[] };
      return makePricingFn(buildRateTable(parsed.daily ?? []));
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

/**
 * Forward ccusage's own diagnostics to our stderr.
 *
 * ccusage warns on stderr when it cannot price a model ("Missing pricing for
 * <model>; cost excludes this model"). That model still contributes tokens
 * but zero dollars, so a swallowed warning turns into a silently understated
 * cost. Surface those lines rather than discarding them.
 *
 * Exported for unit testing.
 */
export function extractWarnings(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bwarn\b/i.test(line));
}

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

    // 1) Preferred path: one call, exact attribution. ccusage >= 20.0.16
    //    embeds a per-agent breakdown in every unified daily row under
    //    `--by-agent`, so we get authoritative (date, agent, model) numbers
    //    without probing each agent separately and without ever having to
    //    guess which harness a shared model belongs to.
    const byAgent = await runCcusage(
      ["daily", "--json", "--by-agent", ...rangeArgs],
      COLLECT_TIMEOUT_MS,
    );
    if (byAgent.exitCode === 0 && byAgent.stdout.trim() !== "") {
      const raw = parseCollectOutput(
        byAgent.stdout,
        byAgent.stderr,
        byAgent.exitCode,
      );
      // Only trust it if the flag actually took effect — an older ccusage
      // that ignores unknown flags would return rows without `agents`.
      if (raw.daily?.some((d) => Array.isArray(d.agents))) {
        for (const w of extractWarnings(byAgent.stderr)) console.warn(w);
        return raw;
      }
    }

    // 2) Fallback for a ccusage without --by-agent: unified daily as the
    //    numeric source of truth, plus per-agent probing for attribution.
    const unified = await runCcusage(
      ["daily", "--json", ...rangeArgs],
      COLLECT_TIMEOUT_MS,
    );
    const raw = parseCollectOutput(
      unified.stdout,
      unified.stderr,
      unified.exitCode,
    );

    // 3) Union of agents across the range (from unified daily's metadata).
    const agentSet = new Set<string>();
    for (const d of raw.daily ?? []) {
      for (const a of d.metadata?.agents ?? []) {
        if (KNOWN_AGENT_SUBCOMMANDS.has(a)) agentSet.add(a);
      }
    }

    // 4) For each agent, fetch its per-agent breakdown in parallel. Treat
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

    for (const w of extractWarnings(unified.stderr)) console.warn(w);
    return { ...raw, perAgent };
  },

  toSnapshot(raw: RawCcusage) {
    return slim(raw, {
      origin: "tool-collected",
      generatedAt: new Date().toISOString(),
    });
  },
};

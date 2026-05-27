import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { slim, type RawCcusage } from "../core/index.js";
import type { UsageAdapter, CollectOpts } from "./types.js";

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
  const binRel =
    typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.ccusage;
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

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn ccusage under the current runtime (`process.execPath` is `node` on
 * Node and `bun` on Bun). Times out via `proc.kill()` after `timeoutMs`.
 */
async function runCcusage(args: string[], timeoutMs: number): Promise<RunResult> {
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

export const ccusageAdapter: UsageAdapter<RawCcusage> = {
  id: "ccusage",

  async available(): Promise<boolean> {
    try {
      const { exitCode } = await runCcusage(["--version"], AVAILABLE_TIMEOUT_MS);
      return exitCode === 0;
    } catch {
      return false;
    }
  },

  async collect(opts: CollectOpts): Promise<RawCcusage> {
    const args = ["daily", "--json"];
    if (opts.from) args.push("--since", opts.from);
    if (opts.to) args.push("--until", opts.to);

    const { exitCode, stdout, stderr } = await runCcusage(
      args,
      COLLECT_TIMEOUT_MS,
    );
    return parseCollectOutput(stdout, stderr, exitCode);
  },

  toSnapshot(raw: RawCcusage) {
    return slim(raw, {
      origin: "tool-collected",
      generatedAt: new Date().toISOString(),
    });
  },
};

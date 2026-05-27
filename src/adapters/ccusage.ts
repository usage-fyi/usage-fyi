import { slim, type RawCcusage } from "@usage-fyi/core";
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

// ccusage is declared as a runtime dependency in package.json (pinned there).
// `bunx ccusage` resolves the local install — no network fetch on first run.

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

export const ccusageAdapter: UsageAdapter<RawCcusage> = {
  id: "ccusage",

  async available(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["bunx", "ccusage", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), AVAILABLE_TIMEOUT_MS);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      return exitCode === 0;
    } catch {
      return false;
    }
  },

  async collect(opts: CollectOpts): Promise<RawCcusage> {
    const args = ["bunx", "ccusage", "daily", "--json"];
    if (opts.from) args.push("--since", opts.from);
    if (opts.to) args.push("--until", opts.to);

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const killTimer = setTimeout(() => proc.kill(), COLLECT_TIMEOUT_MS);

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]).finally(() => clearTimeout(killTimer));

    return parseCollectOutput(stdout, stderr, exitCode);
  },

  toSnapshot(raw: RawCcusage) {
    return slim(raw, {
      origin: "tool-collected",
      generatedAt: new Date().toISOString(),
    });
  },
};

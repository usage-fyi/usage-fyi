import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";

export interface ClaudeSessionResult {
  filePath: string;
  sessionId: string | null;
  cwd: string | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  rawPrEntries: Array<{
    prUrl: string;
    prNumber: number;
    prRepository: string;
    timestamp: string;
    sessionId: string;
  }>;
}

/**
 * Stream a Claude Code JSONL session file line-by-line and extract
 * session metadata plus PR-link events.
 *
 * - sessionStart / sessionEnd: running min / max of entry.timestamp.
 * - cwd: first non-null entry.cwd encountered.
 * - sessionId: from the first pr-link entry, or the file basename.
 * - rawPrEntries: deduplicated by prUrl within the session.
 *
 * Malformed JSON lines are skipped silently.
 */
export async function scanClaudeCodeSession(
  filePath: string,
): Promise<ClaudeSessionResult> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let sessionStart: string | null = null;
  let sessionEnd: string | null = null;
  let cwd: string | null = null;
  let sessionId: string | null = null;

  const seenPrUrls = new Set<string>();
  const rawPrEntries: ClaudeSessionResult["rawPrEntries"] = [];

  let timestampCount = 0;
  let totalLines = 0;

  for await (const line of rl) {
    totalLines++;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;

    if (typeof record.timestamp === "string") {
      timestampCount++;
      if (sessionStart === null || record.timestamp < sessionStart) {
        sessionStart = record.timestamp;
      }
      if (sessionEnd === null || record.timestamp > sessionEnd) {
        sessionEnd = record.timestamp;
      }
    }

    if (cwd === null && typeof record.cwd === "string") {
      cwd = record.cwd;
    }

    if (record.type === "pr-link") {
      const prUrl =
        typeof record.prUrl === "string" ? record.prUrl : undefined;
      const prNumber =
        typeof record.prNumber === "number" ? record.prNumber : undefined;
      const prRepository =
        typeof record.prRepository === "string" ? record.prRepository : undefined;
      const prTimestamp =
        typeof record.timestamp === "string" ? record.timestamp : undefined;
      const prSessionId =
        typeof record.sessionId === "string" ? record.sessionId : undefined;

      if (
        prUrl !== undefined &&
        prNumber !== undefined &&
        prRepository !== undefined &&
        prTimestamp !== undefined &&
        prSessionId !== undefined &&
        !seenPrUrls.has(prUrl)
      ) {
        seenPrUrls.add(prUrl);
        rawPrEntries.push({
          prUrl,
          prNumber,
          prRepository,
          timestamp: prTimestamp,
          sessionId: prSessionId,
        });

        if (sessionId === null) {
          sessionId = prSessionId;
        }
      }
    }
  }

  if (totalLines > 0 && timestampCount / totalLines < 0.5) {
    // debug-level warning only
    // eslint-disable-next-line no-console
    console.debug(
      `Claude Code session ${filePath} has ${timestampCount}/${totalLines} entries with timestamps (< 50%).`,
    );
  }

  if (sessionId === null) {
    // Derive sessionId from basename without extension.
    const base = basename(filePath);
    const dot = base.lastIndexOf(".");
    sessionId = dot > 0 ? base.slice(0, dot) : base;
  }

  return {
    filePath,
    sessionId,
    cwd,
    sessionStart,
    sessionEnd,
    rawPrEntries,
  };
}

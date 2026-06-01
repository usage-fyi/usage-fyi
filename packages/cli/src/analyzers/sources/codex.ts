import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";

export interface CodexSessionResult {
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

const PR_URL_REGEX = /^\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[0-9]+/;

function parsePrUrl(url: string): { prUrl: string; prNumber: number; prRepository: string } | null {
  const match = url.match(/https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([0-9]+)/);
  if (!match) return null;
  const [, owner, repo, numStr] = match;
  const prNumber = Number(numStr);
  if (!Number.isFinite(prNumber)) return null;
  return {
    prUrl: url,
    prNumber,
    prRepository: `${owner}/${repo}`,
  };
}

/**
 * Stream a Codex rollout JSONL session file line-by-line and extract
 * session metadata plus PR-link events found in response_item payload output.
 *
 * - sessionStart / sessionEnd: running min / max of response_item timestamps.
 * - cwd: from the first session_meta entry.
 * - sessionId: from the first session_meta entry, or the file basename.
 * - rawPrEntries: deduplicated by prUrl within the session.
 *
 * Malformed JSON lines are skipped silently.
 */
export async function scanCodexSession(
  filePath: string,
): Promise<CodexSessionResult> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let sessionStart: string | null = null;
  let sessionEnd: string | null = null;
  let cwd: string | null = null;
  let sessionId: string | null = null;

  const seenPrUrls = new Set<string>();
  const rawPrEntries: CodexSessionResult["rawPrEntries"] = [];

  for await (const line of rl) {
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

    if (record.type === "session_meta") {
      if (cwd === null && typeof record.cwd === "string") {
        cwd = record.cwd;
      }
      if (sessionId === null && typeof record.session_id === "string") {
        sessionId = record.session_id;
      }
      continue;
    }

    if (record.type === "response_item") {
      const timestamp =
        typeof record.timestamp === "string" ? record.timestamp : undefined;

      if (timestamp !== undefined) {
        if (sessionStart === null || timestamp < sessionStart) {
          sessionStart = timestamp;
        }
        if (sessionEnd === null || timestamp > sessionEnd) {
          sessionEnd = timestamp;
        }
      }

      const payload =
        typeof record.payload === "object" && record.payload !== null
          ? (record.payload as Record<string, unknown>)
          : undefined;

      const output =
        payload !== undefined && typeof payload.output === "string"
          ? payload.output
          : undefined;

      if (output !== undefined && timestamp !== undefined && sessionId !== null) {
        const lines = output.split("\n");
        for (const textLine of lines) {
          const match = textLine.match(PR_URL_REGEX);
          if (match) {
            const url = match[0].trim();
            const parsed = parsePrUrl(url);
            if (parsed && !seenPrUrls.has(parsed.prUrl)) {
              seenPrUrls.add(parsed.prUrl);
              rawPrEntries.push({
                ...parsed,
                timestamp,
                sessionId,
              });
            }
          }
        }
      }
    }
  }

  if (sessionId === null) {
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

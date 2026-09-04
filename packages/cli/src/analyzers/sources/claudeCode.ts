import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { type TokenEvent, type TokenBreakdown, zeroBreakdown } from "./tokenTypes.js";

export type { TokenEvent, TokenBreakdown };

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
  tokens: TokenEvent[];
}

/**
 * Stream a Claude Code JSONL session file line-by-line and extract
 * session metadata, PR-link events, and per-message token usage.
 *
 * - sessionStart / sessionEnd: running min / max of entry.timestamp.
 * - cwd: first non-null entry.cwd encountered.
 * - sessionId: from the first pr-link entry, or the file basename.
 * - rawPrEntries: deduplicated by prUrl within the session.
 * - tokens: one TokenEvent per assistant message, deduped by requestId.
 *   Missing usage blocks produce a zero-token event with usageMissing: true.
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

  // requestId dedup is per-session; requestIds repeat across sessions.
  const seenRequestIds = new Set<string>();
  const tokens: TokenEvent[] = [];

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
      const prUrl = typeof record.prUrl === "string" ? record.prUrl : undefined;
      const prNumber =
        typeof record.prNumber === "number" ? record.prNumber : undefined;
      const prRepository =
        typeof record.prRepository === "string"
          ? record.prRepository
          : undefined;
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

    if (record.type === "assistant") {
      const timestamp =
        typeof record.timestamp === "string" ? record.timestamp : undefined;
      if (timestamp === undefined) continue;

      // Deduplicate by requestId (first occurrence wins).
      const requestId =
        typeof record.requestId === "string" ? record.requestId : undefined;
      if (requestId !== undefined) {
        if (seenRequestIds.has(requestId)) continue;
        seenRequestIds.add(requestId);
      }

      const isSidechain =
        typeof record.isSidechain === "boolean"
          ? record.isSidechain
          : undefined;

      const message =
        typeof record.message === "object" && record.message !== null
          ? (record.message as Record<string, unknown>)
          : undefined;

      const model =
        message !== undefined && typeof message.model === "string"
          ? message.model
          : null;

      const usage =
        message !== undefined &&
        typeof message.usage === "object" &&
        message.usage !== null
          ? (message.usage as Record<string, unknown>)
          : undefined;

      if (usage === undefined) {
        const event: TokenEvent = {
          timestamp,
          model,
          tokens: zeroBreakdown(),
          source: "claude",
          usageMissing: true,
        };
        if (isSidechain !== undefined) event.isSidechain = isSidechain;
        tokens.push(event);
        continue;
      }

      const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      const cacheReadTokens =
        typeof usage.cache_read_input_tokens === "number"
          ? usage.cache_read_input_tokens
          : 0;
      const cacheCreationTokens =
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0;
      const reasoningTokens = 0;
      const totalTokens =
        inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

      const breakdown: TokenBreakdown = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        reasoningTokens,
        totalTokens,
      };

      const event: TokenEvent = {
        timestamp,
        model,
        tokens: breakdown,
        source: "claude",
      };
      if (isSidechain !== undefined) event.isSidechain = isSidechain;
      tokens.push(event);
    }
  }

  if (totalLines > 0 && timestampCount / totalLines < 0.5) {
    // Diagnostic only — write to stderr so it never pollutes machine-readable
    // stdout (e.g. `pr-stats --json`). console.debug routes to stdout in Node.
    // eslint-disable-next-line no-console
    console.error(
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
    tokens,
  };
}

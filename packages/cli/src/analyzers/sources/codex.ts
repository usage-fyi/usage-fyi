import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { type TokenEvent, type TokenBreakdown, zeroBreakdown } from "./tokenTypes.js";

export type { TokenEvent, TokenBreakdown };

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
  tokens: TokenEvent[];
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
 * session metadata, PR-link events, and per-message token usage.
 *
 * - sessionStart / sessionEnd: running min / max of response_item and event_msg timestamps.
 * - cwd: from the first session_meta entry.
 * - sessionId: from the first session_meta entry, or the file basename.
 * - rawPrEntries: deduplicated by prUrl within the session.
 * - tokens: one TokenEvent per event_msg with payload.type === "token_count",
 *   using the delta from the previous cumulative total_token_usage.
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
  let sessionModel: string | null = null;

  const seenPrUrls = new Set<string>();
  const rawPrEntries: CodexSessionResult["rawPrEntries"] = [];
  const tokens: TokenEvent[] = [];

  // Carry cumulative totals across token_count events to compute deltas.
  let prevCumulative: TokenBreakdown = zeroBreakdown();

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
      if (sessionModel === null && typeof record.model === "string") {
        sessionModel = record.model;
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

    if (record.type === "event_msg") {
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

      if (
        payload !== undefined &&
        payload.type === "token_count" &&
        timestamp !== undefined
      ) {
        const usage =
          typeof payload.total_token_usage === "object" &&
          payload.total_token_usage !== null
            ? (payload.total_token_usage as Record<string, unknown>)
            : undefined;

        if (usage === undefined) {
          tokens.push({
            timestamp,
            model: sessionModel,
            tokens: zeroBreakdown(),
            source: "codex",
            usageMissing: true,
          });
          continue;
        }

        const cumInput = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const cumCacheRead =
          typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0;
        const cumOutput = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        const cumReasoning =
          typeof usage.reasoning_output_tokens === "number"
            ? usage.reasoning_output_tokens
            : 0;

        // Delta from previous cumulative (first event is its own delta).
        const deltaInput = cumInput - prevCumulative.inputTokens;
        const deltaCacheRead = cumCacheRead - prevCumulative.cacheReadTokens;
        const deltaOutput = cumOutput - prevCumulative.outputTokens;
        const deltaReasoning = cumReasoning - prevCumulative.reasoningTokens;
        const deltaTotal =
          deltaInput + deltaCacheRead + deltaOutput + deltaReasoning;

        const breakdown: TokenBreakdown = {
          inputTokens: Math.max(0, deltaInput),
          outputTokens: Math.max(0, deltaOutput),
          cacheReadTokens: Math.max(0, deltaCacheRead),
          cacheCreationTokens: 0,
          reasoningTokens: Math.max(0, deltaReasoning),
          totalTokens: Math.max(0, deltaTotal),
        };

        prevCumulative = {
          inputTokens: cumInput,
          outputTokens: cumOutput,
          cacheReadTokens: cumCacheRead,
          cacheCreationTokens: 0,
          reasoningTokens: cumReasoning,
          totalTokens: cumInput + cumCacheRead + cumOutput + cumReasoning,
        };

        tokens.push({
          timestamp,
          model: sessionModel,
          tokens: breakdown,
          source: "codex",
        });
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
    tokens,
  };
}

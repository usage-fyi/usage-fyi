export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface TokenEvent {
  timestamp: string;
  model: string | null;
  tokens: TokenBreakdown;
  isSidechain?: boolean;
  source: "claude" | "codex";
  usageMissing?: boolean;
}

export function zeroBreakdown(): TokenBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

/**
 * Unit tests for aggregate(), windowSession(), and aggregateTokensByProject().
 */
import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  aggregate,
  windowSession,
  aggregateTokensByProject,
  type AggregateEvent,
  type AggregateSessionMeta,
  type WindowSessionInput,
  type WindowSessionResult,
  type PricingFlag,
} from "../../src/analyzers/index.js";
import { type TokenEvent } from "../../src/analyzers/sources/tokenTypes.js";
import { scanClaudeCodeSession } from "../../src/analyzers/sources/claudeCode.js";
import { scanCodexSession } from "../../src/analyzers/sources/codex.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tokenFixturesDir = join(
  __dirname,
  "..",
  "..",
  "src",
  "analyzers",
  "__fixtures__",
  "tokens",
);

function event(
  project: string,
  sessionId: string,
  createdAt: string,
): AggregateEvent {
  return { project, sessionId, createdAt };
}

function session(
  project: string,
  sessionId: string,
  startedAt: string,
): AggregateSessionMeta {
  return { project, sessionId, startedAt };
}

describe("aggregate() — basic shape", () => {
  it("returns empty byProject when both inputs are empty", () => {
    const result = aggregate([], []);
    expect(Object.keys(result.byProject)).toHaveLength(0);
  });

  it("includes a project seen only in sessionMetas", () => {
    const result = aggregate(
      [],
      [session("org/a", "s1", "2026-06-01T00:00:00Z")],
    );
    expect(result.byProject["org/a"]).toEqual({
      prCount: 0,
      sessionCount: 1,
      sessionsWithNoPR: 1,
      medianMsToFirstPR: null,
      p90MsToFirstPR: null,
    });
  });

  it("includes a project seen only in events", () => {
    const result = aggregate(
      [event("org/b", "s1", "2026-06-01T01:00:00Z")],
      [],
    );
    expect(result.byProject["org/b"]).toEqual({
      prCount: 1,
      sessionCount: 0,
      sessionsWithNoPR: 0,
      medianMsToFirstPR: null,
      p90MsToFirstPR: null,
    });
  });
});

describe("aggregate() — prCount and sessionCount", () => {
  it("counts total PR events per project", () => {
    const result = aggregate(
      [
        event("p", "s1", "2026-06-01T01:00:00Z"),
        event("p", "s1", "2026-06-01T02:00:00Z"),
        event("p", "s2", "2026-06-01T03:00:00Z"),
      ],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    expect(result.byProject["p"]!.prCount).toBe(3);
    expect(result.byProject["p"]!.sessionCount).toBe(2);
    expect(result.byProject["p"]!.sessionsWithNoPR).toBe(0);
  });

  it("counts PRs for unknown sessions toward prCount", () => {
    const result = aggregate(
      [event("p", "unknown", "2026-06-01T01:00:00Z")],
      [session("p", "s1", "2026-06-01T00:00:00Z")],
    );
    expect(result.byProject["p"]!.prCount).toBe(1);
    expect(result.byProject["p"]!.sessionCount).toBe(1);
    expect(result.byProject["p"]!.sessionsWithNoPR).toBe(1);
  });
});

describe("aggregate() — zero-PR sessions", () => {
  it("counts zero-PR sessions but excludes them from percentiles", () => {
    const result = aggregate(
      [event("p", "s1", "2026-06-01T01:00:00Z")],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    const stats = result.byProject["p"]!;
    expect(stats.sessionCount).toBe(2);
    expect(stats.sessionsWithNoPR).toBe(1);
    expect(stats.medianMsToFirstPR).toBe(60 * 60 * 1000);
    expect(stats.p90MsToFirstPR).toBe(60 * 60 * 1000);
  });

  it("returns null percentiles when every session has zero PRs", () => {
    const result = aggregate(
      [],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    const stats = result.byProject["p"]!;
    expect(stats.sessionsWithNoPR).toBe(2);
    expect(stats.medianMsToFirstPR).toBeNull();
    expect(stats.p90MsToFirstPR).toBeNull();
  });
});

describe("aggregate() — median and p90 math", () => {
  it("computes median for odd-length samples", () => {
    const result = aggregate(
      [
        event("p", "s1", "2026-06-01T01:00:00Z"), // 1h
        event("p", "s2", "2026-06-01T02:00:00Z"), // 2h
        event("p", "s3", "2026-06-01T03:00:00Z"), // 3h
      ],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
        session("p", "s3", "2026-06-01T00:00:00Z"),
      ],
    );
    const stats = result.byProject["p"]!;
    expect(stats.medianMsToFirstPR).toBe(2 * 60 * 60 * 1000);
  });

  it("computes median for even-length samples", () => {
    const result = aggregate(
      [
        event("p", "s1", "2026-06-01T01:00:00Z"), // 1h
        event("p", "s2", "2026-06-01T03:00:00Z"), // 3h
      ],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    const stats = result.byProject["p"]!;
    expect(stats.medianMsToFirstPR).toBe(2 * 60 * 60 * 1000);
  });

  it("computes p90 for small samples (nearest-rank)", () => {
    // 1 element → p90 is the only element
    const r1 = aggregate(
      [event("p", "s1", "2026-06-01T01:00:00Z")],
      [session("p", "s1", "2026-06-01T00:00:00Z")],
    );
    expect(r1.byProject["p"]!.p90MsToFirstPR).toBe(60 * 60 * 1000);

    // 2 elements → ceil(0.9*2)-1 = 1 → second element
    const r2 = aggregate(
      [
        event("p", "s1", "2026-06-01T01:00:00Z"), // 1h
        event("p", "s2", "2026-06-01T02:00:00Z"), // 2h
      ],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    expect(r2.byProject["p"]!.p90MsToFirstPR).toBe(2 * 60 * 60 * 1000);

    // 10 elements → ceil(9)-1 = 8 → 9th element (0-indexed)
    const events: AggregateEvent[] = [];
    const sessions: AggregateSessionMeta[] = [];
    for (let i = 1; i <= 10; i++) {
      events.push(event("p", `s${i}`, `2026-06-01T0${i}:00:00Z`));
      sessions.push(session("p", `s${i}`, "2026-06-01T00:00:00Z"));
    }
    const r10 = aggregate(events, sessions);
    expect(r10.byProject["p"]!.p90MsToFirstPR).toBe(9 * 60 * 60 * 1000);
  });
});

describe("aggregate() — earliest PR per session", () => {
  it("uses the earliest PR when a session has multiple PRs", () => {
    const result = aggregate(
      [
        event("p", "s1", "2026-06-01T02:00:00Z"),
        event("p", "s1", "2026-06-01T01:00:00Z"),
        event("p", "s1", "2026-06-01T03:00:00Z"),
      ],
      [session("p", "s1", "2026-06-01T00:00:00Z")],
    );
    expect(result.byProject["p"]!.medianMsToFirstPR).toBe(60 * 60 * 1000);
  });
});

describe("aggregate() — negative msToFirstPR clamping", () => {
  it("clamps negative msToFirstPR to 0 and logs a diagnostic to stderr", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = aggregate(
      [event("p", "s1", "2026-05-31T23:00:00Z")],
      [session("p", "s1", "2026-06-01T00:00:00Z")],
    );

    const stats = result.byProject["p"]!;
    expect(stats.medianMsToFirstPR).toBe(0);
    expect(stats.p90MsToFirstPR).toBe(0);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Negative msToFirstPR"),
    );

    errorSpy.mockRestore();
  });
});

describe("aggregate() — multiple projects", () => {
  it("partitions stats by canonical project path", () => {
    const result = aggregate(
      [
        event("org/a", "s1", "2026-06-01T01:00:00Z"),
        event("org/b", "s2", "2026-06-01T02:00:00Z"),
      ],
      [
        session("org/a", "s1", "2026-06-01T00:00:00Z"),
        session("org/b", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    expect(result.byProject["org/a"]!.prCount).toBe(1);
    expect(result.byProject["org/b"]!.prCount).toBe(1);
    expect(result.byProject["org/a"]!.medianMsToFirstPR).toBe(60 * 60 * 1000);
    expect(result.byProject["org/b"]!.medianMsToFirstPR).toBe(
      2 * 60 * 60 * 1000,
    );
  });
});

// ─── windowSession() ────────────────────────────────────────────────────────

function makeToken(
  timestamp: string,
  overrides: Partial<TokenEvent> = {},
): TokenEvent {
  return {
    timestamp,
    model: "claude-opus-4-8",
    tokens: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      reasoningTokens: 0,
      totalTokens: 135,
    },
    source: "claude",
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<WindowSessionInput> = {},
): WindowSessionInput {
  return {
    sessionId: "sess-1",
    project: "org/repo",
    sessionStart: "2026-06-01T00:00:00.000Z",
    sessionEnd: "2026-06-01T02:00:00.000Z",
    prs: [],
    tokens: [],
    ...overrides,
  };
}

describe("windowSession() — dry session (no PRs)", () => {
  it("returns isDrySession=true and empty perPR", () => {
    const result = windowSession(
      makeInput({ tokens: [makeToken("2026-06-01T01:00:00.000Z")] }),
    );
    expect(result.isDrySession).toBe(true);
    expect(result.perPR).toHaveLength(0);
    expect(result.overhead.totalTokens).toBe(0);
    expect(result.session.prCount).toBe(0);
    expect(result.session.tokensAttributed).toBe("windowed");
    expect(result.session.tokens.totalTokens).toBe(135);
  });

  it("session totals reflect all tokens for a dry session", () => {
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z"),
      makeToken("2026-06-01T01:00:00.000Z"),
    ];
    const result = windowSession(makeInput({ tokens }));
    expect(result.session.tokens.totalTokens).toBe(270);
    expect(result.session.tokens.inputTokens).toBe(200);
  });
});

describe("windowSession() — single PR, no overhead", () => {
  it("attributes all tokens to window 1 when they precede the PR", () => {
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z"),
      makeToken("2026-06-01T00:45:00.000Z"),
    ];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(makeInput({ tokens, prs }));

    expect(result.isDrySession).toBe(false);
    expect(result.perPR).toHaveLength(1);
    expect(result.perPR[0]!.tokens.totalTokens).toBe(270);
    expect(result.perPR[0]!.msToPR).toBe(60 * 60 * 1000); // 1h
    expect(result.perPR[0]!.msFromPrevPR).toBeNull(); // first PR
    expect(result.perPR[0]!.tokensAttributed).toBe("windowed");
    expect(result.overhead.totalTokens).toBe(0);
  });

  it("overhead captures tokens at or after the PR timestamp", () => {
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z"), // before PR → window 1
      makeToken("2026-06-01T01:00:00.000Z"), // exactly at PR ts → overhead
      makeToken("2026-06-01T01:30:00.000Z"), // after PR → overhead
    ];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(makeInput({ tokens, prs }));

    expect(result.perPR[0]!.tokens.totalTokens).toBe(135); // only pre-PR token
    expect(result.overhead.totalTokens).toBe(270); // two tokens at/after PR
  });
});

describe("windowSession() — multiple PRs, window boundaries", () => {
  it("partitions tokens into per-PR windows with correct boundaries", () => {
    // t=0h: session start
    // t=0.5h: token A → window 1
    // t=1h: PR#1
    // t=1.25h: token B → window 2
    // t=2h: PR#2
    // t=2.5h: token C → overhead
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z"), // A: window 1
      makeToken("2026-06-01T01:15:00.000Z"), // B: window 2
      makeToken("2026-06-01T02:30:00.000Z"), // C: overhead
    ];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
      {
        prUrl: "https://github.com/a/b/pull/2",
        prTimestamp: "2026-06-01T02:00:00.000Z",
      },
    ];
    const result = windowSession(
      makeInput({ tokens, prs, sessionEnd: "2026-06-01T03:00:00.000Z" }),
    );

    expect(result.perPR).toHaveLength(2);
    expect(result.perPR[0]!.tokens.totalTokens).toBe(135); // token A
    expect(result.perPR[1]!.tokens.totalTokens).toBe(135); // token B
    expect(result.overhead.totalTokens).toBe(135); // token C

    expect(result.perPR[0]!.msToPR).toBe(60 * 60 * 1000); // 1h from start to PR#1
    expect(result.perPR[1]!.msToPR).toBe(60 * 60 * 1000); // 1h from PR#1 to PR#2
    expect(result.perPR[1]!.msFromPrevPR).toBe(60 * 60 * 1000);
    expect(result.perPR[0]!.msFromPrevPR).toBeNull();
  });

  it("token at exactly PR#1 timestamp belongs to window 2, not window 1", () => {
    const tokens = [makeToken("2026-06-01T01:00:00.000Z")]; // exactly at PR#1
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
      {
        prUrl: "https://github.com/a/b/pull/2",
        prTimestamp: "2026-06-01T02:00:00.000Z",
      },
    ];
    const result = windowSession(makeInput({ tokens, prs }));
    expect(result.perPR[0]!.tokens.totalTokens).toBe(0); // window 1 is empty
    expect(result.perPR[1]!.tokens.totalTokens).toBe(135); // token is in window 2
  });
});

describe("windowSession() — same-timestamp PRs", () => {
  it("splits window tokens evenly and flags approximate", () => {
    const tokens = [makeToken("2026-06-01T00:30:00.000Z")]; // 135 total
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
      {
        prUrl: "https://github.com/a/b/pull/2",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(makeInput({ tokens, prs }));

    expect(result.perPR).toHaveLength(2);
    expect(result.perPR[0]!.tokens.totalTokens).toBe(135 / 2);
    expect(result.perPR[1]!.tokens.totalTokens).toBe(135 / 2);
    expect(result.perPR[0]!.tokensAttributed).toBe("approximate");
    expect(result.perPR[1]!.tokensAttributed).toBe("approximate");
    expect(result.session.tokensAttributed).toBe("approximate");
  });
});

describe("windowSession() — out-of-order / missing timestamps", () => {
  it("degrades to session-only when sessionStart is unparseable", () => {
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(
      makeInput({ sessionStart: "not-a-date", prs }),
    );
    expect(result.session.tokensAttributed).toBe("session-only");
    expect(result.perPR).toHaveLength(0);
  });

  it("degrades to session-only when a PR timestamp is unparseable", () => {
    const prs = [
      { prUrl: "https://github.com/a/b/pull/1", prTimestamp: "bad-date" },
    ];
    const result = windowSession(makeInput({ prs }));
    expect(result.session.tokensAttributed).toBe("session-only");
  });

  it("degrades to session-only when a token timestamp is unparseable", () => {
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const tokens = [makeToken("bad-date")];
    const result = windowSession(makeInput({ prs, tokens }));
    expect(result.session.tokensAttributed).toBe("session-only");
  });

  it("still reports correct session-level token totals even in session-only mode", () => {
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z"),
      makeToken("2026-06-01T01:00:00.000Z"),
    ];
    const prs = [
      { prUrl: "https://github.com/a/b/pull/1", prTimestamp: "bad-date" },
    ];
    const result = windowSession(makeInput({ tokens, prs }));
    expect(result.session.tokensAttributed).toBe("session-only");
    expect(result.session.tokens.totalTokens).toBe(270);
  });
});

describe("windowSession() — usageMissing flag", () => {
  it("sets usageMissing=true on a PR window where all events lack usage", () => {
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z", {
        usageMissing: true,
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
      }),
    ];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(makeInput({ tokens, prs }));
    expect(result.perPR[0]!.usageMissing).toBe(true);
  });

  it("does not set usageMissing when the window has no token events", () => {
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(makeInput({ prs, tokens: [] }));
    expect(result.perPR[0]!.usageMissing).toBe(false);
  });
});

describe("windowSession() — sidechain tokens", () => {
  it("tracks sidechain tokens separately at session and PR level", () => {
    const mainToken = makeToken("2026-06-01T00:30:00.000Z", {
      isSidechain: false,
    });
    const sideToken = makeToken("2026-06-01T00:45:00.000Z", {
      isSidechain: true,
    });
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(
      makeInput({ tokens: [mainToken, sideToken], prs }),
    );

    expect(result.session.sidechainTokens.totalTokens).toBe(135);
    expect(result.session.tokens.totalTokens).toBe(270); // both main + sidechain
    expect(result.perPR[0]!.sidechainTokens.totalTokens).toBe(135);
    expect(result.perPR[0]!.tokens.totalTokens).toBe(270);
  });
});

describe("windowSession() — session metrics", () => {
  it("computes durationMs from sessionStart to sessionEnd", () => {
    const result = windowSession(
      makeInput({
        sessionStart: "2026-06-01T00:00:00.000Z",
        sessionEnd: "2026-06-01T02:00:00.000Z",
      }),
    );
    expect(result.session.durationMs).toBe(2 * 60 * 60 * 1000);
  });

  it("computes tokensPerActiveMinute when durationMs > 0", () => {
    // 1 token of 600 total tokens over 60 minutes → 10 tokens/min
    const token = makeToken("2026-06-01T00:30:00.000Z", {
      tokens: {
        inputTokens: 600,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalTokens: 600,
      },
    });
    const result = windowSession(
      makeInput({
        tokens: [token],
        sessionStart: "2026-06-01T00:00:00.000Z",
        sessionEnd: "2026-06-01T01:00:00.000Z",
      }),
    );
    expect(result.session.tokensPerActiveMinute).toBeCloseTo(10, 5);
  });

  it("sets tokensPerActiveMinute to null when durationMs is 0", () => {
    const result = windowSession(
      makeInput({ sessionStart: "2026-06-01T00:00:00.000Z", sessionEnd: null }),
    );
    expect(result.session.tokensPerActiveMinute).toBeNull();
  });

  it("collects unique model ids across token events", () => {
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z", { model: "claude-opus-4-8" }),
      makeToken("2026-06-01T00:45:00.000Z", { model: "claude-sonnet-4-6" }),
      makeToken("2026-06-01T01:00:00.000Z", { model: "claude-opus-4-8" }),
    ];
    const result = windowSession(makeInput({ tokens }));
    expect(result.session.models).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]);
  });
});

// ─── aggregateTokensByProject() ─────────────────────────────────────────────

function makeWindowResult(
  project: string,
  overrides: Partial<WindowSessionResult> = {},
): WindowSessionResult {
  return {
    session: {
      sessionId: "s1",
      project,
      durationMs: 3600000,
      prCount: 0,
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
      sidechainTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
      models: [],
      outputShare: null,
      cacheHitRatio: null,
      tokensPerActiveMinute: null,
      tokensAttributed: "windowed",
      estimatedCostUsd: null,
    },
    perPR: [],
    overhead: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    overheadSidechain: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    isDrySession: false,
    ...overrides,
  };
}

describe("aggregateTokensByProject() — basic rollup", () => {
  it("returns empty record for empty input", () => {
    const result = aggregateTokensByProject([]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("accumulates dry tokens from sessions with no PRs", () => {
    const session = makeWindowResult("org/repo", {
      isDrySession: true,
      session: {
        sessionId: "s1",
        project: "org/repo",
        durationMs: 3600000,
        prCount: 0,
        tokens: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
          reasoningTokens: 0,
          totalTokens: 135,
        },
        sidechainTokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        models: [],
        outputShare: null,
        cacheHitRatio: null,
        tokensPerActiveMinute: null,
        tokensAttributed: "windowed",
        estimatedCostUsd: null,
      },
    });
    const result = aggregateTokensByProject([session]);
    expect(result["org/repo"]!.dryTokens.totalTokens).toBe(135);
    expect(result["org/repo"]!.productiveTokens.totalTokens).toBe(0);
    expect(result["org/repo"]!.overheadTokens.totalTokens).toBe(0);
    expect(result["org/repo"]!.dryTokenShare).toBe(1);
  });

  it("accumulates productive + overhead tokens from PR-shipping sessions", () => {
    const prResult = windowSession(
      makeInput({
        tokens: [
          makeToken("2026-06-01T00:30:00.000Z"), // window: 135 tokens
          makeToken("2026-06-01T01:30:00.000Z"), // overhead: 135 tokens
        ],
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/1",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
        ],
      }),
    );
    const result = aggregateTokensByProject([prResult]);
    const stats = result["org/repo"]!;
    expect(stats.productiveTokens.totalTokens).toBe(135);
    expect(stats.overheadTokens.totalTokens).toBe(135);
    expect(stats.dryTokens.totalTokens).toBe(0);
    expect(stats.totalTokens.totalTokens).toBe(270);
  });
});

describe("aggregateTokensByProject() — efficiency ratios", () => {
  it("computes dryTokenShare as dry/total", () => {
    const dry = makeWindowResult("p", {
      isDrySession: true,
      session: {
        sessionId: "dry",
        project: "p",
        durationMs: 0,
        prCount: 0,
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          totalTokens: 400,
        },
        sidechainTokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        models: [],
        outputShare: null,
        cacheHitRatio: null,
        tokensPerActiveMinute: null,
        tokensAttributed: "windowed",
        estimatedCostUsd: null,
      },
    });
    const productive = windowSession(
      makeInput({
        project: "p",
        tokens: [
          makeToken("2026-06-01T00:30:00.000Z", {
            tokens: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              reasoningTokens: 0,
              totalTokens: 600,
            },
          }),
        ],
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/1",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
        ],
      }),
    );
    const result = aggregateTokensByProject([dry, productive]);
    const stats = result["p"]!;
    expect(stats.totalTokens.totalTokens).toBe(1000);
    expect(stats.dryTokenShare).toBeCloseTo(0.4, 5); // 400/1000
  });

  it("computes tokensPerPR as productiveTokens / prCount", () => {
    const r1 = windowSession(
      makeInput({
        tokens: [
          makeToken("2026-06-01T00:30:00.000Z", {
            tokens: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              reasoningTokens: 0,
              totalTokens: 1000,
            },
          }),
        ],
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/1",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
        ],
      }),
    );
    const r2 = windowSession(
      makeInput({
        sessionId: "s2",
        tokens: [
          makeToken("2026-06-01T00:30:00.000Z", {
            tokens: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              reasoningTokens: 0,
              totalTokens: 2000,
            },
          }),
        ],
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/2",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
          {
            prUrl: "https://github.com/a/b/pull/3",
            prTimestamp: "2026-06-01T02:00:00.000Z",
          },
        ],
      }),
    );
    const result = aggregateTokensByProject([r1, r2]);
    const stats = result["org/repo"]!;
    expect(stats.productiveTokens.totalTokens).toBe(3000); // 1000 + 2000
    // r1: 1 PR, r2: 2 PRs = 3 total
    expect(stats.tokensPerPR).toBeCloseTo(3000 / 3, 5);
  });

  it("returns tokensPerPR=null when there are no PRs", () => {
    const dry = makeWindowResult("p", { isDrySession: true });
    const result = aggregateTokensByProject([dry]);
    expect(result["p"]!.tokensPerPR).toBeNull();
  });

  it("returns prsPerMTok=null when there are no tokens", () => {
    const result = aggregateTokensByProject([makeWindowResult("p")]);
    expect(result["p"]!.prsPerMTok).toBeNull();
  });

  it("returns dryTokenShare=0 when there are no tokens at all", () => {
    const result = aggregateTokensByProject([makeWindowResult("p")]);
    expect(result["p"]!.dryTokenShare).toBe(0);
  });
});

describe("aggregateTokensByProject() — session-only attribution", () => {
  it("attributes all tokens to productive for session-only sessions", () => {
    const bad = windowSession(
      makeInput({
        tokens: [makeToken("2026-06-01T00:30:00.000Z")],
        prs: [
          { prUrl: "https://github.com/a/b/pull/1", prTimestamp: "bad-date" },
        ],
      }),
    );
    expect(bad.session.tokensAttributed).toBe("session-only");
    const result = aggregateTokensByProject([bad]);
    const stats = result["org/repo"]!;
    expect(stats.productiveTokens.totalTokens).toBe(135);
    expect(stats.dryTokens.totalTokens).toBe(0);
    expect(stats.overheadTokens.totalTokens).toBe(0);
  });
});

describe("aggregateTokensByProject() — multiple projects", () => {
  it("partitions stats by project", () => {
    // org/a: dry session with no tokens (prs=[])
    const a = windowSession(makeInput({ project: "org/a" }));
    // org/b: dry session with tokens (prs=[] → isDrySession=true)
    const bDry = windowSession(
      makeInput({
        project: "org/b",
        tokens: [makeToken("2026-06-01T00:30:00.000Z")],
      }),
    );
    const result = aggregateTokensByProject([a, bDry]);
    expect(result["org/a"]).toBeDefined();
    expect(result["org/b"]).toBeDefined();
    expect(result["org/b"]!.dryTokens.totalTokens).toBe(135);
    expect(result["org/a"]!.dryTokens.totalTokens).toBe(0);
  });
});

// ─── Pricing support ─────────────────────────────────────────────────────────

/** Synthetic pricing fn: 0.001 $/token for "claude-opus-4-8", unknown otherwise. */
function mockPricingFn(
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
): { usd: number | null; flag?: PricingFlag } {
  const totalTokens =
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheCreationTokens +
    tokens.cacheReadTokens;
  if (model === "claude-opus-4-8")
    return { usd: 0.001 * totalTokens, flag: "blended-rate" };
  return { usd: null, flag: "unknown-model" };
}

/** Synthetic pricing fn charging each token type its own rate. */
function typedPricingFn(
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
): { usd: number | null; flag?: PricingFlag } {
  if (model !== "claude-opus-4-8") return { usd: null, flag: "unknown-model" };
  return {
    usd:
      tokens.inputTokens * 1e-6 +
      tokens.outputTokens * 10e-6 +
      tokens.cacheCreationTokens * 2e-6 +
      tokens.cacheReadTokens * 0.1e-6,
    flag: "modeled-rate",
  };
}

describe("windowSession() — per-token-type pricing", () => {
  const prs = [
    {
      prUrl: "https://github.com/a/b/pull/1",
      prTimestamp: "2026-06-01T01:00:00.000Z",
    },
  ];

  /** Same total tokens, opposite mix: all output vs all cache-read. */
  const outputHeavy = makeToken("2026-06-01T00:30:00.000Z", {
    tokens: {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1_000_000,
    },
  });
  const cacheHeavy = makeToken("2026-06-01T00:30:00.000Z", {
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1_000_000,
    },
  });

  it("charges an output-heavy window far more than a cache-heavy one", () => {
    const out = windowSession(
      makeInput({ tokens: [outputHeavy], prs, pricingFn: typedPricingFn }),
    );
    const cache = windowSession(
      makeInput({ tokens: [cacheHeavy], prs, pricingFn: typedPricingFn }),
    );
    expect(out.perPR[0]!.estimatedCostUsd).toBeCloseTo(10, 9);
    expect(cache.perPR[0]!.estimatedCostUsd).toBeCloseTo(0.1, 9);
    // The old blended-scalar model priced these two identically.
    const blendedOut = windowSession(
      makeInput({ tokens: [outputHeavy], prs, pricingFn: mockPricingFn }),
    );
    const blendedCache = windowSession(
      makeInput({ tokens: [cacheHeavy], prs, pricingFn: mockPricingFn }),
    );
    expect(blendedOut.perPR[0]!.estimatedCostUsd).toBe(
      blendedCache.perPR[0]!.estimatedCostUsd,
    );
  });

  it("reports the modeled-rate flag when every model was modeled", () => {
    const r = windowSession(
      makeInput({ tokens: [outputHeavy], prs, pricingFn: typedPricingFn }),
    );
    expect(r.perPR[0]!.pricingFlag).toBe("modeled-rate");
    expect(r.session.pricingFlag).toBe("modeled-rate");
  });

  it("prices each model in a mixed window against its own token mix", () => {
    const other = makeToken("2026-06-01T00:40:00.000Z", {
      model: "other-model",
    });
    const r = windowSession(
      makeInput({
        tokens: [outputHeavy, other],
        prs,
        pricingFn: typedPricingFn,
      }),
    );
    // "other-model" has no rate, so the whole window is unpriceable.
    expect(r.perPR[0]!.estimatedCostUsd).toBeNull();
    expect(r.perPR[0]!.pricingFlag).toBe("unknown-model");
  });

  it("degrades the flag to blended-rate when any model fell back", () => {
    const mixed = (
      model: string,
      tokens: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
      },
    ): { usd: number | null; flag?: PricingFlag } =>
      model === "claude-opus-4-8"
        ? typedPricingFn(model, tokens)
        : { usd: 1, flag: "blended-rate" };

    const other = makeToken("2026-06-01T00:40:00.000Z", {
      model: "other-model",
    });
    const r = windowSession(
      makeInput({ tokens: [outputHeavy, other], prs, pricingFn: mixed }),
    );
    expect(r.perPR[0]!.pricingFlag).toBe("blended-rate");
  });
});

describe("windowSession() — pricing", () => {
  it("populates estimatedCostUsd on a PR window with a known model", () => {
    // 270 tokens × $0.001/token = $0.270
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z"), // 135 tokens, model claude-opus-4-8
      makeToken("2026-06-01T00:45:00.000Z"), // 135 tokens
    ];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(
      makeInput({ tokens, prs, pricingFn: mockPricingFn }),
    );
    expect(result.perPR[0]!.estimatedCostUsd).toBeCloseTo(0.27, 10);
    expect(result.perPR[0]!.pricingFlag).toBe("blended-rate");
  });

  it("returns null cost with unknown-model flag for an unrecognised model", () => {
    const token = makeToken("2026-06-01T00:30:00.000Z", {
      model: "mystery-model",
    });
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(
      makeInput({ tokens: [token], prs, pricingFn: mockPricingFn }),
    );
    expect(result.perPR[0]!.estimatedCostUsd).toBeNull();
    expect(result.perPR[0]!.pricingFlag).toBe("unknown-model");
  });

  it("leaves cost null when no pricingFn provided", () => {
    const tokens = [makeToken("2026-06-01T00:30:00.000Z")];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(makeInput({ tokens, prs }));
    expect(result.perPR[0]!.estimatedCostUsd).toBeNull();
    expect(result.perPR[0]!.pricingFlag).toBeUndefined();
    expect(result.session.estimatedCostUsd).toBeNull();
  });

  it("session cost equals window cost plus overhead cost", () => {
    // token A at 0:30 → window for PR#1 (135 tokens)
    // token B at 1:30 → overhead (135 tokens)
    // total session cost = (135 + 135) × 0.001 = 0.270
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z"), // 135 tokens → window
      makeToken("2026-06-01T01:30:00.000Z"), // 135 tokens → overhead
    ];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(
      makeInput({ tokens, prs, pricingFn: mockPricingFn }),
    );
    expect(result.perPR[0]!.estimatedCostUsd).toBeCloseTo(0.135, 10);
    expect(result.session.estimatedCostUsd).toBeCloseTo(0.27, 10);
    expect(result.session.pricingFlag).toBe("blended-rate");
  });

  it("session cost is null when overhead has an unknown model", () => {
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z"), // window: known model
      makeToken("2026-06-01T01:30:00.000Z", { model: "mystery" }), // overhead: unknown
    ];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(
      makeInput({ tokens, prs, pricingFn: mockPricingFn }),
    );
    expect(result.session.estimatedCostUsd).toBeNull();
    expect(result.session.pricingFlag).toBe("unknown-model");
  });

  it("dry session cost uses session-level tokens and model", () => {
    // dry session: 135 tokens with known model
    const tokens = [makeToken("2026-06-01T00:30:00.000Z")];
    const result = windowSession(
      makeInput({ tokens, pricingFn: mockPricingFn }),
    );
    expect(result.isDrySession).toBe(true);
    expect(result.session.estimatedCostUsd).toBeCloseTo(0.135, 10);
    expect(result.session.pricingFlag).toBe("blended-rate");
  });

  it("multi-model window averages per-model USD estimates", () => {
    // Two models in the window: claude-opus-4-8 (known) and mystery (unknown)
    // → average unknown → null
    const tokens = [
      makeToken("2026-06-01T00:30:00.000Z", { model: "claude-opus-4-8" }),
      makeToken("2026-06-01T00:45:00.000Z", { model: "mystery" }),
    ];
    const prs = [
      {
        prUrl: "https://github.com/a/b/pull/1",
        prTimestamp: "2026-06-01T01:00:00.000Z",
      },
    ];
    const result = windowSession(
      makeInput({ tokens, prs, pricingFn: mockPricingFn }),
    );
    expect(result.perPR[0]!.estimatedCostUsd).toBeNull();
    expect(result.perPR[0]!.pricingFlag).toBe("unknown-model");
  });
});

describe("aggregateTokensByProject() — pricing", () => {
  it("sums session costs across sessions for a project", () => {
    const r1 = windowSession(
      makeInput({
        tokens: [makeToken("2026-06-01T00:30:00.000Z")], // 135 tokens → window
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/1",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
        ],
        pricingFn: mockPricingFn,
      }),
    );
    const r2 = windowSession(
      makeInput({
        sessionId: "s2",
        tokens: [makeToken("2026-06-01T00:30:00.000Z")], // another 135 tokens
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/2",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
        ],
        pricingFn: mockPricingFn,
      }),
    );
    const stats = aggregateTokensByProject([r1, r2])["org/repo"]!;
    expect(stats.estimatedCostUsd).toBeCloseTo(0.135 * 2, 10);
    expect(stats.pricingFlag).toBe("blended-rate");
  });

  it("returns null project cost when any session has unknown model", () => {
    const knownSession = windowSession(
      makeInput({
        tokens: [makeToken("2026-06-01T00:30:00.000Z")],
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/1",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
        ],
        pricingFn: mockPricingFn,
      }),
    );
    const unknownSession = windowSession(
      makeInput({
        sessionId: "s2",
        tokens: [makeToken("2026-06-01T00:30:00.000Z", { model: "mystery" })],
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/2",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
        ],
        pricingFn: mockPricingFn,
      }),
    );
    const stats = aggregateTokensByProject([knownSession, unknownSession])[
      "org/repo"
    ]!;
    expect(stats.estimatedCostUsd).toBeNull();
    expect(stats.pricingFlag).toBe("unknown-model");
  });

  it("returns null cost with no pricingFlag when no pricingFn was used", () => {
    const r = windowSession(
      makeInput({
        tokens: [makeToken("2026-06-01T00:30:00.000Z")],
        prs: [
          {
            prUrl: "https://github.com/a/b/pull/1",
            prTimestamp: "2026-06-01T01:00:00.000Z",
          },
        ],
      }),
    );
    const stats = aggregateTokensByProject([r])["org/repo"]!;
    expect(stats.estimatedCostUsd).toBeNull();
    expect(stats.pricingFlag).toBeUndefined();
  });
});

// ─── Hand-built fixture tests ────────────────────────────────────────────────
//
// Each test loads a JSONL fixture from __fixtures__/tokens/, scans it with the
// real scanner, then feeds the result into windowSession(). Expected token
// totals are computed by hand from the fixture file contents — the comments
// document the arithmetic so a reviewer can re-derive the numbers without
// running the tests.

/** Minimal pricing fn: returns cost for known models, unknown-model for others. */
function fixturePricingFn(
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
): { usd: number | null; flag?: PricingFlag } {
  const knownModels = new Set([
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-8",
  ]);
  const totalTokens =
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheCreationTokens +
    tokens.cacheReadTokens;
  if (knownModels.has(model))
    return { usd: 0.001 * totalTokens, flag: "blended-rate" };
  return { usd: null, flag: "unknown-model" };
}

function toWindowInput(
  result: Awaited<ReturnType<typeof scanClaudeCodeSession>>,
  project = "fixture/repo",
): Parameters<typeof windowSession>[0] {
  return {
    sessionId: result.sessionId ?? "unknown",
    project,
    sessionStart: result.sessionStart ?? "2026-06-10T00:00:00.000Z",
    sessionEnd: result.sessionEnd,
    prs: result.rawPrEntries.map((p) => ({
      prUrl: p.prUrl,
      prTimestamp: p.timestamp,
    })),
    tokens: result.tokens,
  };
}

describe("fixture: claude-multi-pr — multi-PR windowing", () => {
  // Fixture layout (all 2026-06-10, each message = input:100 + output:20 = 120 tokens):
  //   T+05..T+15: msgs 1-3  → window 1 for PR#100 (T+30) = 3×120 = 360
  //   T+35..T+45: msgs 4-6  → window 2 for PR#101 (T+90) = 3×120 = 360
  //   T+95..T+100: msgs 7-8 → overhead                   = 2×120 = 240
  //   Session total = 960
  it("produces two PR windows plus overhead", async () => {
    const result = await scanClaudeCodeSession(
      join(tokenFixturesDir, "claude-multi-pr.jsonl"),
    );

    expect(result.rawPrEntries).toHaveLength(2);
    expect(result.tokens).toHaveLength(8);

    const wr = windowSession(toWindowInput(result));

    expect(wr.isDrySession).toBe(false);
    expect(wr.session.tokensAttributed).toBe("windowed");
    expect(wr.perPR).toHaveLength(2);
    // Window 1: msgs 1-3 (3 × 120 = 360)
    expect(wr.perPR[0]!.tokens.totalTokens).toBe(360);
    expect(wr.perPR[0]!.tokens.inputTokens).toBe(300);
    expect(wr.perPR[0]!.tokens.outputTokens).toBe(60);
    // Window 2: msgs 4-6 (3 × 120 = 360)
    expect(wr.perPR[1]!.tokens.totalTokens).toBe(360);
    // Overhead: msgs 7-8 (2 × 120 = 240)
    expect(wr.overhead.totalTokens).toBe(240);
    // Session total = 960
    expect(wr.session.tokens.totalTokens).toBe(960);
  });
});

describe("fixture: claude-dry-session — no PRs", () => {
  // 3 messages (3 × 120 = 360 tokens), no pr-link → all tokens are dry spend.
  it("marks session as dry with full token count", async () => {
    const result = await scanClaudeCodeSession(
      join(tokenFixturesDir, "claude-dry-session.jsonl"),
    );

    expect(result.rawPrEntries).toHaveLength(0);
    expect(result.tokens).toHaveLength(3);

    const wr = windowSession(toWindowInput(result));

    expect(wr.isDrySession).toBe(true);
    expect(wr.perPR).toHaveLength(0);
    expect(wr.overhead.totalTokens).toBe(0);
    // All 3 messages: 3 × 120 = 360
    expect(wr.session.tokens.totalTokens).toBe(360);
    expect(wr.session.tokens.inputTokens).toBe(300);
    expect(wr.session.tokens.outputTokens).toBe(60);
  });
});

describe("fixture: claude-sidechain — sidechain token split", () => {
  // Layout (all before PR#200 at T+30):
  //   req-s1 main    (isSidechain:false): input:100 + output:20 = 120
  //   req-s2 sidechain (isSidechain:true): input:50  + output:10 = 60
  //   req-s3 main    (isSidechain:false): input:100 + output:20 = 120
  //   Window total = 300; sidechain portion = 60
  it("separates sidechain tokens from main-chain tokens", async () => {
    const result = await scanClaudeCodeSession(
      join(tokenFixturesDir, "claude-sidechain.jsonl"),
    );

    expect(result.rawPrEntries).toHaveLength(1);
    expect(result.tokens).toHaveLength(3);

    const wr = windowSession(toWindowInput(result));

    expect(wr.isDrySession).toBe(false);
    expect(wr.perPR).toHaveLength(1);
    // Window total: 120 + 60 + 120 = 300
    expect(wr.perPR[0]!.tokens.totalTokens).toBe(300);
    // Sidechain portion: 60 (only req-s2)
    expect(wr.perPR[0]!.sidechainTokens.totalTokens).toBe(60);
    // Session-level mirrors the window (no overhead)
    expect(wr.session.tokens.totalTokens).toBe(300);
    expect(wr.session.sidechainTokens.totalTokens).toBe(60);
    expect(wr.overhead.totalTokens).toBe(0);
  });
});

describe("fixture: claude-dedupe — duplicate requestId suppression", () => {
  // req-dd1 appears twice at T+05 and T+06 (same requestId).
  // Only the first occurrence is counted: 120 tokens.
  // req-dd2 appears once: input:60 + output:20 = 80 tokens.
  // Window total after dedup = 120 + 80 = 200 (not 120+120+80 = 320).
  it("collapses duplicate requestId entries to one token event", async () => {
    const result = await scanClaudeCodeSession(
      join(tokenFixturesDir, "claude-dedupe.jsonl"),
    );

    // Two unique requestIds → two token events (not three)
    expect(result.tokens).toHaveLength(2);

    const wr = windowSession(toWindowInput(result));

    expect(wr.perPR).toHaveLength(1);
    // 120 (req-dd1) + 80 (req-dd2) = 200
    expect(wr.perPR[0]!.tokens.totalTokens).toBe(200);
    expect(wr.session.tokens.totalTokens).toBe(200);
  });
});

describe("fixture: codex-cumulative — monotonically rising cumulative totals", () => {
  // Three token_count events, each adding delta={input:100, cached:50, output:30} = 180:
  //   event1 T+05: cumulative {input:100, cached:50, output:30} → delta 180 (window 1)
  //   response_item T+10: PR#400 (window boundary)
  //   event2 T+15: cumulative {input:200, cached:100, output:60} → delta 180 (overhead)
  //   event3 T+20: cumulative {input:300, cached:150, output:90} → delta 180 (overhead)
  //   Session total = 3 × 180 = 540; window 1 = 180; overhead = 360
  it("computes per-event deltas from cumulative counters", async () => {
    const result = await scanCodexSession(
      join(tokenFixturesDir, "codex-cumulative.jsonl"),
    );

    expect(result.sessionId).toBe("codex-cum-001");
    expect(result.rawPrEntries).toHaveLength(1);
    expect(result.tokens).toHaveLength(3);

    // Each delta: input=100, cacheRead=50, output=30 → total=180
    for (const t of result.tokens) {
      expect(t.tokens.totalTokens).toBe(180);
      expect(t.tokens.inputTokens).toBe(100);
      expect(t.tokens.cacheReadTokens).toBe(50);
      expect(t.tokens.outputTokens).toBe(30);
    }

    const wr = windowSession({
      sessionId: result.sessionId ?? "unknown",
      project: "fixture/repo",
      sessionStart: result.sessionStart ?? "2026-06-10T13:00:00.000Z",
      sessionEnd: result.sessionEnd,
      prs: result.rawPrEntries.map((p) => ({
        prUrl: p.prUrl,
        prTimestamp: p.timestamp,
      })),
      tokens: result.tokens,
    });

    expect(wr.isDrySession).toBe(false);
    expect(wr.perPR).toHaveLength(1);
    // Window 1: only event1 (T+05) is before PR@T+10 → 180 tokens
    expect(wr.perPR[0]!.tokens.totalTokens).toBe(180);
    // Overhead: events 2 and 3 (both after T+10) → 360
    expect(wr.overhead.totalTokens).toBe(360);
    // Session total = 540
    expect(wr.session.tokens.totalTokens).toBe(540);
  });
});

describe("fixture: out-of-order — non-monotonic timestamps degrade to session-only", () => {
  // req-oo1 (T+10) appears before req-oo2 (T+05) in the file (out of order).
  // req-oo3 carries an invalid month-13 timestamp ("2026-13-10T14:15:00.000Z"),
  // which parseTs() cannot resolve. windowSession detects a null tsMs and
  // falls back to session-only attribution (no per-PR windows).
  // All 3 events still count toward the session total: 3 × 120 = 360.
  it("falls back to session-only and still reports full session token count", async () => {
    const result = await scanClaudeCodeSession(
      join(tokenFixturesDir, "out-of-order.jsonl"),
    );

    // All 3 assistant entries are scanned (including the one with invalid ts)
    expect(result.tokens).toHaveLength(3);

    const wr = windowSession(toWindowInput(result));

    expect(wr.session.tokensAttributed).toBe("session-only");
    expect(wr.perPR).toHaveLength(0);
    // Session total: 3 × 120 = 360 (all events included even with invalid ts)
    expect(wr.session.tokens.totalTokens).toBe(360);
  });
});

describe("fixture: unknown-model — unrecognised model produces null cost", () => {
  // Single message with model:"claude-mystery" (not in the pricing rate map).
  // Window total = 120; with a pricingFn, estimatedCostUsd=null and
  // pricingFlag="unknown-model".
  it("returns unknown-model flag when pricingFn cannot price the model", async () => {
    const result = await scanClaudeCodeSession(
      join(tokenFixturesDir, "unknown-model.jsonl"),
    );

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]!.model).toBe("claude-mystery");

    const wr = windowSession({
      ...toWindowInput(result),
      pricingFn: fixturePricingFn,
    });

    expect(wr.perPR).toHaveLength(1);
    // Window 1: 120 tokens (input:100 + output:20)
    expect(wr.perPR[0]!.tokens.totalTokens).toBe(120);
    // Unknown model → null cost
    expect(wr.perPR[0]!.estimatedCostUsd).toBeNull();
    expect(wr.perPR[0]!.pricingFlag).toBe("unknown-model");
    expect(wr.session.estimatedCostUsd).toBeNull();
    expect(wr.session.pricingFlag).toBe("unknown-model");
  });
});

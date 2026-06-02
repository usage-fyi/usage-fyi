/**
 * Unit tests for aggregate(), windowSession(), and aggregateTokensByProject().
 */
import { describe, it, expect, vi } from "vitest";
import {
  aggregate,
  windowSession,
  aggregateTokensByProject,
  type AggregateEvent,
  type AggregateSessionMeta,
  type WindowSessionInput,
  type WindowSessionResult,
} from "../../src/analyzers/index.js";
import { type TokenEvent } from "../../src/analyzers/sources/tokenTypes.js";

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
  totalTokens: number,
): { usd: number | null; flag?: "unknown-model" | "blended-rate" } {
  if (model === "claude-opus-4-8")
    return { usd: 0.001 * totalTokens, flag: "blended-rate" };
  return { usd: null, flag: "unknown-model" };
}

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

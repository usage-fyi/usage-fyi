/**
 * Unit tests for snapshot/2 attribution in slim().
 *
 * Covers the three attribution paths (unambiguous, ambiguous, fallback) and
 * verifies the five hard invariants the server validator enforces.
 */
import { describe, it, expect } from "vitest";
import { slim, type RawCcusage, type Snapshot } from "../src/core/index.js";

const FIXED_TS = "2026-05-28T00:00:00.000Z";

/** Sum mb[].k for one day. */
const dailySum = (
  daily: Snapshot["daily"][number],
  key: "i" | "o" | "cc" | "cr" | "t",
): number => daily.mb.reduce((acc, e) => acc + e[key], 0);

/** Round to 2dp. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Assert the five hard invariants for every day. */
function assertInvariants(snap: Snapshot): void {
  for (const d of snap.daily) {
    // 1) Per-day token sums.
    expect(dailySum(d, "i")).toBe(d.i);
    expect(dailySum(d, "o")).toBe(d.o);
    expect(dailySum(d, "cc")).toBe(d.cc);
    expect(dailySum(d, "cr")).toBe(d.cr);
    expect(dailySum(d, "t")).toBe(d.t);

    // 2) Day cost is round2 of sum(mb.c); each mb.c already rounded to 2dp.
    const cSum = d.mb.reduce((acc, e) => acc + e.c, 0);
    expect(d.c).toBe(round2(cSum));
    for (const e of d.mb) expect(e.c).toBe(round2(e.c));

    // 3) Day m = sortedUnique(mb.m).
    const expectedM = [...new Set(d.mb.map((e) => e.m))].sort();
    expect(d.m).toEqual(expectedM);

    // 4) Day a = sortedUnique(mb.a).
    const expectedA = [...new Set(d.mb.map((e) => e.a))].sort();
    expect(d.a).toEqual(expectedA);

    // 5) mb sorted ASC by (a, m); empty only on no-data days.
    const sorted = [...d.mb].sort((x, y) =>
      x.a < y.a ? -1 : x.a > y.a ? 1 : x.m < y.m ? -1 : x.m > y.m ? 1 : 0,
    );
    expect(d.mb).toEqual(sorted);
    if (d.mb.length === 0) {
      const isEmpty =
        d.i === 0 && d.o === 0 && d.cc === 0 && d.cr === 0 && d.t === 0 && d.c === 0;
      expect(isEmpty).toBe(true);
    }
  }
}

describe("slim() — snapshot/2 schema and source", () => {
  it("emits schema snapshot/2", () => {
    const snap = slim(
      { daily: [], perAgent: {} },
      { origin: "tool-collected", generatedAt: FIXED_TS },
    );
    expect(snap.schema).toBe("snapshot/2");
  });

  it("emits source.adapter '2' by default", () => {
    const snap = slim(
      { daily: [], perAgent: {} },
      { origin: "tool-collected", generatedAt: FIXED_TS },
    );
    expect(snap.source.adapter).toBe("2");
  });
});

describe("slim() — unambiguous attribution", () => {
  const raw: RawCcusage = {
    daily: [
      {
        period: "2026-05-20",
        modelsUsed: ["claude-opus-4-7", "gpt-5.4"],
        inputTokens: 1500,
        outputTokens: 300,
        cacheCreationTokens: 200,
        cacheReadTokens: 400,
        totalTokens: 2400,
        totalCost: 1.25,
        metadata: { agents: ["claude", "codex"] },
        modelBreakdowns: [
          {
            modelName: "claude-opus-4-7",
            inputTokens: 1000,
            outputTokens: 200,
            cacheCreationTokens: 150,
            cacheReadTokens: 300,
            totalTokens: 1650,
            cost: 0.75,
          },
          {
            modelName: "gpt-5.4",
            inputTokens: 500,
            outputTokens: 100,
            cacheCreationTokens: 50,
            cacheReadTokens: 100,
            totalTokens: 750,
            cost: 0.5,
          },
        ],
      },
    ],
    perAgent: {
      claude: {
        daily: [{ date: "2026-05-20", modelsUsed: ["claude-opus-4-7"] }],
      },
      codex: {
        daily: [
          {
            date: "2026-05-20",
            models: { "gpt-5.4": {} },
          },
        ],
      },
    },
  };

  const snap = slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS });

  it("attributes claude-opus-4-7 to claude only", () => {
    const day = snap.daily[0]!;
    const entry = day.mb.find((e) => e.m === "claude-opus-4-7")!;
    expect(entry.a).toBe("claude");
    expect(entry.i).toBe(1000);
    expect(entry.o).toBe(200);
  });

  it("attributes gpt-5.4 to codex only", () => {
    const day = snap.daily[0]!;
    const entry = day.mb.find((e) => e.m === "gpt-5.4")!;
    expect(entry.a).toBe("codex");
    expect(entry.i).toBe(500);
  });

  it("satisfies all invariants", () => {
    assertInvariants(snap);
  });
});

describe("slim() — ambiguous attribution (two agents claim same model)", () => {
  const raw: RawCcusage = {
    daily: [
      {
        period: "2026-05-21",
        modelsUsed: ["shared-model"],
        inputTokens: 1001, // odd → tests integer-remainder steering
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 1201,
        totalCost: 0.33,
        metadata: { agents: ["claude", "codex"] },
        modelBreakdowns: [
          {
            modelName: "shared-model",
            inputTokens: 1001,
            outputTokens: 200,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 1201,
            cost: 0.33,
          },
        ],
      },
    ],
    perAgent: {
      claude: { daily: [{ date: "2026-05-21", modelsUsed: ["shared-model"] }] },
      codex: { daily: [{ date: "2026-05-21", modelsUsed: ["shared-model"] }] },
    },
  };

  const snap = slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS });

  it("splits into two mb entries", () => {
    expect(snap.daily[0]!.mb).toHaveLength(2);
  });

  it("attributes split across both agents alphabetically", () => {
    expect(snap.daily[0]!.mb.map((e) => e.a)).toEqual(["claude", "codex"]);
  });

  it("token sums preserved exactly despite odd integer split", () => {
    const day = snap.daily[0]!;
    expect(day.mb.reduce((s, e) => s + e.i, 0)).toBe(1001);
    expect(day.mb.reduce((s, e) => s + e.o, 0)).toBe(200);
    expect(day.mb.reduce((s, e) => s + e.t, 0)).toBe(1201);
  });

  it("first agent absorbs the integer remainder (501 vs 500)", () => {
    const claude = snap.daily[0]!.mb.find((e) => e.a === "claude")!;
    const codex = snap.daily[0]!.mb.find((e) => e.a === "codex")!;
    expect(claude.i).toBe(501);
    expect(codex.i).toBe(500);
  });

  it("satisfies all invariants", () => {
    assertInvariants(snap);
  });
});

describe("slim() — fallback inference when no per-agent claims the model", () => {
  const raw: RawCcusage = {
    daily: [
      {
        period: "2026-05-22",
        modelsUsed: ["claude-sonnet-4-6", "gpt-5.4", "gemini-3-flash-preview", "qwen3-coder", "kimi-for-coding", "weird-vendor-foo"],
        inputTokens: 60,
        outputTokens: 60,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 120,
        totalCost: 0.06,
        metadata: { agents: [] },
        modelBreakdowns: [
          { modelName: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 0.01 },
          { modelName: "gpt-5.4", inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 0.01 },
          { modelName: "gemini-3-flash-preview", inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 0.01 },
          { modelName: "qwen3-coder", inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 0.01 },
          { modelName: "kimi-for-coding", inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 0.01 },
          { modelName: "weird-vendor-foo", inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 0.01 },
        ],
      },
    ],
    perAgent: {},
  };

  const snap = slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS });
  const byModel = new Map(snap.daily[0]!.mb.map((e) => [e.m, e.a]));

  it("infers claude-* → claude", () => {
    expect(byModel.get("claude-sonnet-4-6")).toBe("claude");
  });
  it("infers gpt-* → codex", () => {
    expect(byModel.get("gpt-5.4")).toBe("codex");
  });
  it("infers gemini-* → gemini", () => {
    expect(byModel.get("gemini-3-flash-preview")).toBe("gemini");
  });
  it("infers qwen* → qwen", () => {
    expect(byModel.get("qwen3-coder")).toBe("qwen");
  });
  it("infers kimi-* → kimi", () => {
    expect(byModel.get("kimi-for-coding")).toBe("kimi");
  });
  it("everything else → other", () => {
    expect(byModel.get("weird-vendor-foo")).toBe("other");
  });
  it("satisfies all invariants", () => {
    assertInvariants(snap);
  });
});

describe("slim() — codex per-agent payload (different schema)", () => {
  // Real shape from `ccusage codex daily --json`: models is an object keyed
  // by name, not an array. Ensures buildAttributionLookup handles it.
  const raw: RawCcusage = {
    daily: [
      {
        period: "2026-05-16",
        modelsUsed: ["gpt-5.4"],
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        totalCost: 0.1,
        metadata: { agents: ["codex"] },
        modelBreakdowns: [
          { modelName: "gpt-5.4", inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.1 },
        ],
      },
    ],
    perAgent: {
      codex: {
        // Object-keyed `models`, no modelsUsed array — codex's actual shape.
        daily: [{ date: "2026-05-16", models: { "gpt-5.4": {} } }],
      },
    },
  };

  const snap = slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS });

  it("attributes gpt-5.4 to codex via models{} lookup", () => {
    expect(snap.daily[0]!.mb[0]!.a).toBe("codex");
  });

  it("satisfies all invariants", () => {
    assertInvariants(snap);
  });
});

describe("slim() — empty-day handling", () => {
  const raw: RawCcusage = {
    daily: [
      {
        period: "2026-05-23",
        modelsUsed: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        metadata: { agents: ["claude"] },
      },
    ],
    perAgent: {},
  };

  const snap = slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS });

  it("emits empty mb for the no-data day", () => {
    expect(snap.daily[0]!.mb).toEqual([]);
  });

  it("clears m and a on the empty day (no attribution to make)", () => {
    expect(snap.daily[0]!.m).toEqual([]);
    expect(snap.daily[0]!.a).toEqual([]);
  });

  it("satisfies all invariants", () => {
    assertInvariants(snap);
  });
});

describe("slim() — legacy raw without modelBreakdowns falls back gracefully", () => {
  // Older ccusage versions / fixture files lacked modelBreakdowns. The
  // committed test fixture (ccusage-daily.json) is in this shape.
  const raw: RawCcusage = {
    daily: [
      {
        period: "2026-05-24",
        modelsUsed: ["claude-opus-4-7"],
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        totalTokens: 180,
        totalCost: 0.1,
        metadata: { agents: ["claude"] },
        // No modelBreakdowns.
      },
    ],
    perAgent: {},
  };

  const snap = slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS });

  it("synthesises one mb entry per model from day totals", () => {
    expect(snap.daily[0]!.mb).toHaveLength(1);
    expect(snap.daily[0]!.mb[0]!.m).toBe("claude-opus-4-7");
    expect(snap.daily[0]!.mb[0]!.a).toBe("claude");
  });

  it("satisfies all invariants", () => {
    assertInvariants(snap);
  });
});

// ─── exact per-agent attribution (ccusage --by-agent) ────────────────────────

describe("slim() — exact attribution from daily[].agents[]", () => {
  /**
   * Same model used by two different harnesses on the same day. Under the
   * legacy heuristic this was ambiguous and got split evenly; with
   * `--by-agent` ccusage tells us the real split, so the numbers must be
   * carried through verbatim rather than halved.
   */
  const raw: RawCcusage = {
    daily: [
      {
        period: "2026-08-01",
        modelsUsed: ["claude-sonnet-5", "gpt-5.5"],
        inputTokens: 1000,
        outputTokens: 300,
        cacheCreationTokens: 40,
        cacheReadTokens: 8000,
        totalTokens: 9340,
        totalCost: 6.0,
        metadata: { agents: ["claude", "opencode"] },
        modelBreakdowns: [
          {
            modelName: "claude-sonnet-5",
            inputTokens: 900,
            outputTokens: 250,
            cacheCreationTokens: 40,
            cacheReadTokens: 7000,
            cost: 5,
          },
          {
            modelName: "gpt-5.5",
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 0,
            cacheReadTokens: 1000,
            cost: 1,
          },
        ],
        agents: [
          {
            agent: "claude",
            modelBreakdowns: [
              {
                modelName: "claude-sonnet-5",
                inputTokens: 700,
                outputTokens: 200,
                cacheCreationTokens: 40,
                cacheReadTokens: 6000,
                cost: 4,
              },
            ],
          },
          {
            agent: "opencode",
            modelBreakdowns: [
              {
                modelName: "claude-sonnet-5",
                inputTokens: 200,
                outputTokens: 50,
                cacheCreationTokens: 0,
                cacheReadTokens: 1000,
                cost: 1,
              },
              {
                modelName: "gpt-5.5",
                inputTokens: 100,
                outputTokens: 50,
                cacheCreationTokens: 0,
                cacheReadTokens: 1000,
                cost: 1,
              },
            ],
          },
        ],
      },
    ],
    // Deliberately contradicts agents[] — the exact payload must win.
    perAgent: { claude: { daily: [{ date: "2026-08-01", modelsUsed: ["gpt-5.5"] }] } },
  };

  const snap = slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS });
  const day = snap.daily[0]!;

  it("emits one mb entry per (agent, model) pair", () => {
    expect(day.mb).toHaveLength(3);
    expect(day.mb.map((e) => `${e.a}/${e.m}`)).toEqual([
      "claude/claude-sonnet-5",
      "opencode/claude-sonnet-5",
      "opencode/gpt-5.5",
    ]);
  });

  it("carries the real split verbatim instead of splitting evenly", () => {
    const claude = day.mb.find((e) => e.a === "claude")!;
    expect(claude.i).toBe(700);
    expect(claude.o).toBe(200);
    expect(claude.cr).toBe(6000);
    expect(claude.c).toBe(4);
    // An even split of the model's 900 input tokens would have been 450.
    expect(claude.i).not.toBe(450);
  });

  it("ignores the per-agent probe lookup when agents[] is present", () => {
    // perAgent claims claude used gpt-5.5; agents[] says otherwise.
    expect(day.mb.some((e) => e.a === "claude" && e.m === "gpt-5.5")).toBe(false);
  });

  it("derives day totals as the exact sum of the agent rows", () => {
    expect(day.i).toBe(1000);
    expect(day.o).toBe(300);
    expect(day.cc).toBe(40);
    expect(day.cr).toBe(8000);
    expect(day.t).toBe(9340);
    expect(day.c).toBe(6);
  });

  it("lists every agent that actually used tokens", () => {
    expect(day.a).toEqual(["claude", "opencode"]);
    expect(day.m).toEqual(["claude-sonnet-5", "gpt-5.5"]);
  });

  it("satisfies all invariants", () => {
    assertInvariants(snap);
  });
});

describe("slim() — agents[] fallback behaviour", () => {
  it("falls back to the heuristic path when agents[] carries no model rows", () => {
    const raw: RawCcusage = {
      daily: [
        {
          period: "2026-08-02",
          modelsUsed: ["claude-opus-5"],
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 15,
          totalCost: 0.5,
          metadata: { agents: ["claude"] },
          modelBreakdowns: [
            {
              modelName: "claude-opus-5",
              inputTokens: 10,
              outputTokens: 5,
              cost: 0.5,
            },
          ],
          agents: [{ agent: "claude", modelBreakdowns: [] }],
        },
      ],
      perAgent: {},
    };
    const snap = slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS });
    expect(snap.daily[0]!.mb).toHaveLength(1);
    expect(snap.daily[0]!.mb[0]!.a).toBe("claude");
    assertInvariants(snap);
  });
});

// ─── cost is preserved across splits ─────────────────────────────────────────

describe("slim() — sub-cent splits do not lose money", () => {
  /**
   * Splitting a raw float cost N ways and rounding each share to 2dp
   * independently is not the same as rounding the sum: $0.01 across three
   * buckets is $0.00333 each, which rounds to zero three times and drops the
   * cent from the day total. The split has to happen in whole cents.
   */
  it("keeps a one-cent cost when three agents claim the same model", () => {
    const raw: RawCcusage = {
      daily: [
        {
          period: "2026-08-01",
          modelsUsed: ["shared-model"],
          inputTokens: 300,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 300,
          totalCost: 0.01,
          metadata: { agents: ["a", "b", "c"] },
          modelBreakdowns: [
            {
              modelName: "shared-model",
              inputTokens: 300,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              cost: 0.01,
            },
          ],
        },
      ],
      perAgent: {
        a: { daily: [{ date: "2026-08-01", modelsUsed: ["shared-model"] }] },
        b: { daily: [{ date: "2026-08-01", modelsUsed: ["shared-model"] }] },
        c: { daily: [{ date: "2026-08-01", modelsUsed: ["shared-model"] }] },
      },
    };
    const snap = slim(raw, {
      origin: "tool-collected",
      generatedAt: FIXED_TS,
    });
    expect(snap.daily[0]!.c).toBe(0.01);
    expect(snap.totals.c).toBe(0.01);
    // The remaining cent goes to the alphabetically-first agent, so the
    // result stays deterministic across runs.
    expect(snap.daily[0]!.mb.map((e) => e.c)).toEqual([0.01, 0, 0]);
    assertInvariants(snap);
  });

  it("keeps the day cost when three models split it in the legacy path", () => {
    const raw: RawCcusage = {
      daily: [
        {
          period: "2026-08-02",
          modelsUsed: ["m-a", "m-b", "m-c"],
          inputTokens: 300,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 300,
          totalCost: 0.01,
          metadata: { agents: ["claude"] },
          // No modelBreakdowns — forces the even-split fallback.
        },
      ],
      perAgent: {},
    };
    const snap = slim(raw, {
      origin: "tool-collected",
      generatedAt: FIXED_TS,
    });
    expect(snap.daily[0]!.c).toBe(0.01);
    assertInvariants(snap);
  });

  it("preserves an odd cost across an even split", () => {
    const raw: RawCcusage = {
      daily: [
        {
          period: "2026-08-03",
          modelsUsed: ["shared-model"],
          inputTokens: 1000,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 1000,
          totalCost: 12.37,
          metadata: { agents: ["a", "b"] },
          modelBreakdowns: [
            {
              modelName: "shared-model",
              inputTokens: 1000,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              cost: 12.37,
            },
          ],
        },
      ],
      perAgent: {
        a: { daily: [{ date: "2026-08-03", modelsUsed: ["shared-model"] }] },
        b: { daily: [{ date: "2026-08-03", modelsUsed: ["shared-model"] }] },
      },
    };
    const snap = slim(raw, {
      origin: "tool-collected",
      generatedAt: FIXED_TS,
    });
    expect(snap.daily[0]!.c).toBe(12.37);
    expect(snap.daily[0]!.mb.map((e) => e.c)).toEqual([6.19, 6.18]);
    assertInvariants(snap);
  });
});

import { describe, it, expect } from "vitest";
import {
  ccusageAdapter,
  CollectError,
  parseCollectOutput,
  normalizeModelId,
  buildRateTable,
  extractWarnings,
  makePricingFn,
} from "../src/adapters/ccusage.js";
import fixture from "./fixtures/ccusage-daily.json" with { type: "json" };
import type { RawCcusage } from "../src/core/index.js";

const raw = fixture as unknown as RawCcusage;

describe("ccusageAdapter", () => {
  it("has id 'ccusage'", () => {
    expect(ccusageAdapter.id).toBe("ccusage");
  });
});

describe("ccusageAdapter.toSnapshot", () => {
  it("produces a snapshot with origin tool-collected", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(snap.origin).toBe("tool-collected");
  });

  it("produces schema snapshot/2", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(snap.schema).toBe("snapshot/2");
  });

  it("sets source.tool to ccusage", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(snap.source.tool).toBe("ccusage");
  });

  it("sets source.adapter to '2'", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(snap.source.adapter).toBe("2");
  });

  it("daily entry count matches fixture", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(snap.daily).toHaveLength(fixture.daily.length);
  });

  it("generatedAt is a valid ISO timestamp", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(new Date(snap.generatedAt).getTime()).not.toBeNaN();
  });

  it("totals and derived.windows are present", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(snap.totals).toBeDefined();
    expect(snap.derived.windows.d7).toBeDefined();
    expect(snap.derived.windows.d30).toBeDefined();
    expect(snap.derived.windows.all).toBeDefined();
  });
});

describe("CollectError", () => {
  it("is an Error subclass", () => {
    const err = new CollectError("msg", "some stderr", 1);
    expect(err).toBeInstanceOf(Error);
  });

  it("has name CollectError", () => {
    const err = new CollectError("msg", "some stderr", 1);
    expect(err.name).toBe("CollectError");
  });

  it("carries stderr", () => {
    const err = new CollectError("msg", "captured stderr text", 2);
    expect(err.stderr).toBe("captured stderr text");
  });

  it("carries exitCode", () => {
    const err = new CollectError("msg", "", 127);
    expect(err.exitCode).toBe(127);
  });

  it("accepts null exitCode", () => {
    const err = new CollectError("timed out", "", null);
    expect(err.exitCode).toBeNull();
  });
});

describe("parseCollectOutput", () => {
  it("throws CollectError on non-zero exit code", () => {
    expect(() => parseCollectOutput("", "error text", 1)).toThrow(CollectError);
  });

  it("CollectError from non-zero exit carries exit code", () => {
    let caught: unknown;
    try {
      parseCollectOutput("", "oops", 2);
    } catch (e) {
      caught = e;
    }
    expect((caught as CollectError).exitCode).toBe(2);
    expect((caught as CollectError).stderr).toBe("oops");
  });

  it("throws CollectError on empty stdout (exit 0)", () => {
    expect(() => parseCollectOutput("   \n", "", 0)).toThrow(CollectError);
  });

  it("throws CollectError on non-JSON stdout", () => {
    expect(() => parseCollectOutput("not json at all", "", 0)).toThrow(
      CollectError,
    );
  });

  it("throws CollectError on truncated JSON", () => {
    expect(() => parseCollectOutput('{"daily": [', "", 0)).toThrow(
      CollectError,
    );
  });

  it("returns parsed object on valid JSON (exit 0)", () => {
    const result = parseCollectOutput('{"daily":[]}', "", 0);
    expect(result).toEqual({ daily: [] });
  });

  it("parses the real fixture shape", () => {
    const result = parseCollectOutput(JSON.stringify(fixture), "", 0);
    expect((result as { daily: unknown[] }).daily).toHaveLength(
      fixture.daily.length,
    );
  });
});

describe("normalizeModelId", () => {
  it("leaves model ids without a date suffix unchanged", () => {
    expect(normalizeModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("strips an 8-digit trailing date suffix", () => {
    expect(normalizeModelId("claude-opus-4-8-20260301")).toBe(
      "claude-opus-4-8",
    );
  });

  it("only strips the last -YYYYMMDD segment", () => {
    expect(normalizeModelId("claude-sonnet-4-6-20250929")).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("does not strip segments shorter or longer than 8 digits", () => {
    expect(normalizeModelId("model-2026")).toBe("model-2026");
    expect(normalizeModelId("model-202603011")).toBe("model-202603011");
  });
});

describe("buildRateTable", () => {
  const tok = (i: number, o: number, cc: number, cr: number) => ({
    inputTokens: i,
    outputTokens: o,
    cacheCreationTokens: cc,
    cacheReadTokens: cr,
  });

  /**
   * Rows priced exactly at $1/M in, $10/M out, $2/M cache-create,
   * $0.1/M cache-read. The token mix is varied per row with a small
   * deterministic PRNG: the rates are only identifiable when the four
   * columns are not collinear, which is what real day-to-day usage looks
   * like.
   */
  function pricedRows(n: number) {
    const RI = 1 / 1e6, RO = 10 / 1e6, RCC = 2 / 1e6, RCR = 0.1 / 1e6;
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    return Array.from({ length: n }, () => {
      const i = Math.round(500 + rnd() * 5000);
      const o = Math.round(100 + rnd() * 3000);
      const cc = Math.round(10 + rnd() * 2000);
      const cr = Math.round(1000 + rnd() * 90000);
      return {
        totalTokens: i + o + cc + cr,
        totalCost: i * RI + o * RO + cc * RCC + cr * RCR,
        modelBreakdowns: [
          {
            modelName: "m",
            inputTokens: i,
            outputTokens: o,
            cacheCreationTokens: cc,
            cacheReadTokens: cr,
            cost: i * RI + o * RO + cc * RCC + cr * RCR,
          },
        ],
      };
    });
  }

  it("recovers the true per-token-type rates from enough observations", () => {
    const table = buildRateTable(pricedRows(12));
    const entry = table.get("m");
    expect(entry?.kind).toBe("modeled");
    if (entry?.kind !== "modeled") throw new Error("expected a modeled rate");
    expect(entry.rates.input * 1e6).toBeCloseTo(1, 6);
    expect(entry.rates.output * 1e6).toBeCloseTo(10, 6);
    expect(entry.rates.cacheCreation * 1e6).toBeCloseTo(2, 6);
    expect(entry.rates.cacheRead * 1e6).toBeCloseTo(0.1, 6);
  });

  it("falls back to a blended rate when there is too little history", () => {
    const table = buildRateTable(pricedRows(3));
    expect(table.get("m")?.kind).toBe("blended");
  });

  it("never emits a negative rate", () => {
    // Input and cache-read move together here, which makes an unconstrained
    // fit want a negative input rate.
    const rows = Array.from({ length: 10 }, (_, k) => {
      const i = 1000 * (k + 1);
      const cr = 100_000 * (k + 1);
      return {
        totalTokens: i + cr,
        totalCost: 0.01 * (k + 1),
        modelBreakdowns: [
          {
            modelName: "m",
            inputTokens: i,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: cr,
            cost: 0.01 * (k + 1),
          },
        ],
      };
    });
    const entry = buildRateTable(rows).get("m");
    if (entry?.kind !== "modeled") throw new Error("expected a modeled rate");
    for (const r of Object.values(entry.rates)) expect(r).toBeGreaterThanOrEqual(0);
  });

  it("normalizes dated model ids before storing", () => {
    const rows = pricedRows(12).map((r) => ({
      ...r,
      modelBreakdowns: r.modelBreakdowns.map((b) => ({
        ...b,
        modelName: "claude-haiku-4-5-20251001",
      })),
    }));
    const table = buildRateTable(rows);
    expect(table.has("claude-haiku-4-5")).toBe(true);
    expect(table.has("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("falls back to the day blended rate when no modelBreakdowns are present", () => {
    const table = buildRateTable([
      { modelsUsed: ["model-a", "model-b"], totalTokens: 1000, totalCost: 2.0 },
    ]);
    expect(table.get("model-a")).toEqual({ kind: "blended", perToken: 0.002 });
    expect(table.get("model-b")).toEqual({ kind: "blended", perToken: 0.002 });
  });

  it("skips rows with zero totalTokens", () => {
    const table = buildRateTable([
      { modelsUsed: ["m"], totalTokens: 0, totalCost: 0 },
    ]);
    expect(table.has("m")).toBe(false);
  });

  it("derives usable rates from the real fixture data", () => {
    const table = buildRateTable(
      fixture.daily as Parameters<typeof buildRateTable>[0],
    );
    expect(table.size).toBeGreaterThan(0);
    for (const entry of table.values()) {
      if (entry.kind === "blended") {
        expect(entry.perToken).toBeGreaterThan(0);
        expect(Number.isFinite(entry.perToken)).toBe(true);
      } else {
        for (const r of Object.values(entry.rates)) {
          expect(r).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(r)).toBe(true);
        }
      }
    }
  });

  it("prices a cache-heavy window far below a blended rate", () => {
    const table = buildRateTable(pricedRows(12));
    const fn = makePricingFn(table);
    const cacheHeavy = tok(0, 0, 0, 1_000_000);
    const modeled = fn("m", cacheHeavy).usd!;
    // The blended scalar over this history is dominated by cache reads but
    // still averages in $10/M output, so it over-charges pure cache reads.
    const blendedTable = buildRateTable(pricedRows(3));
    const blended = makePricingFn(blendedTable)("m", cacheHeavy).usd!;
    expect(modeled).toBeCloseTo(0.1, 6);
    expect(blended).toBeGreaterThan(modeled);
  });
});

describe("makePricingFn", () => {
  const tok = (i: number, o: number, cc: number, cr: number) => ({
    inputTokens: i,
    outputTokens: o,
    cacheCreationTokens: cc,
    cacheReadTokens: cr,
  });

  it("returns unknown-model for a model not in the table", () => {
    const fn = makePricingFn(new Map());
    expect(fn("nope", tok(1000, 0, 0, 0))).toEqual({
      usd: null,
      flag: "unknown-model",
    });
  });

  it("charges each token type at its own rate for a modeled entry", () => {
    const fn = makePricingFn(
      new Map([
        [
          "m",
          {
            kind: "modeled" as const,
            rates: {
              input: 1 / 1e6,
              output: 10 / 1e6,
              cacheCreation: 2 / 1e6,
              cacheRead: 0.1 / 1e6,
            },
          },
        ],
      ]),
    );
    const r = fn("m", tok(1e6, 1e6, 1e6, 1e6));
    expect(r.usd).toBeCloseTo(13.1, 9);
    expect(r.flag).toBe("modeled-rate");
  });

  it("returns blended-rate and computed USD for a blended entry", () => {
    const fn = makePricingFn(
      new Map([["claude-opus-4-8", { kind: "blended" as const, perToken: 0.001 }]]),
    );
    expect(fn("claude-opus-4-8", tok(1000, 0, 0, 0))).toEqual({
      usd: 1.0,
      flag: "blended-rate",
    });
  });

  it("normalizes a dated suffix before lookup", () => {
    const fn = makePricingFn(
      new Map([["claude-opus-4-8", { kind: "blended" as const, perToken: 0.002 }]]),
    );
    const result = fn("claude-opus-4-8-20260301", tok(500, 0, 0, 0));
    expect(result.usd).toBeCloseTo(1.0, 10);
    expect(result.flag).toBe("blended-rate");
  });

  it("returns 0 USD for 0 tokens of a known model", () => {
    const fn = makePricingFn(
      new Map([["m", { kind: "blended" as const, perToken: 0.001 }]]),
    );
    expect(fn("m", tok(0, 0, 0, 0))).toEqual({ usd: 0, flag: "blended-rate" });
  });
});

describe("extractWarnings", () => {
  it("picks out ccusage's pricing warnings", () => {
    const stderr = [
      "Loading usage data...",
      "WARN  Missing pricing for brand-new-model; cost excludes this model.",
      "",
      "WARN Failed to fetch LiteLLM pricing (timeout); using embedded pricing.",
    ].join("\n");
    expect(extractWarnings(stderr)).toEqual([
      "WARN  Missing pricing for brand-new-model; cost excludes this model.",
      "WARN Failed to fetch LiteLLM pricing (timeout); using embedded pricing.",
    ]);
  });

  it("returns nothing for clean stderr", () => {
    expect(extractWarnings("")).toEqual([]);
    expect(extractWarnings("Loading usage data...\n")).toEqual([]);
  });

  it("does not match a word merely containing warn", () => {
    expect(extractWarnings("forewarned is forearmed")).toEqual([]);
  });
});

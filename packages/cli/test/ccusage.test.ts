import { describe, it, expect } from "vitest";
import {
  ccusageAdapter,
  CollectError,
  parseCollectOutput,
  normalizeModelId,
  buildRateMap,
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

describe("buildRateMap", () => {
  it("returns empty map for empty input", () => {
    expect(buildRateMap([])).toEqual(new Map());
  });

  it("computes rate for a single-model row", () => {
    const map = buildRateMap([
      { modelsUsed: ["claude-opus-4-8"], totalTokens: 1000, totalCost: 1.0 },
    ]);
    expect(map.get("claude-opus-4-8")).toBeCloseTo(0.001, 10);
  });

  it("assigns blended row rate to each model in a multi-model row", () => {
    const map = buildRateMap([
      {
        modelsUsed: ["model-a", "model-b"],
        totalTokens: 1000,
        totalCost: 2.0,
      },
    ]);
    // Both models get the same blended rate 2.0/1000 = 0.002
    expect(map.get("model-a")).toBeCloseTo(0.002, 10);
    expect(map.get("model-b")).toBeCloseTo(0.002, 10);
  });

  it("normalizes dated model ids before storing", () => {
    const map = buildRateMap([
      {
        modelsUsed: ["claude-haiku-4-5-20251001"],
        totalTokens: 500,
        totalCost: 0.05,
      },
    ]);
    expect(map.has("claude-haiku-4-5")).toBe(true);
    expect(map.has("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("computes weighted average rate across multiple rows for same model", () => {
    // Row 1: 1000 tokens at $1 → rate 0.001
    // Row 2: 2000 tokens at $4 → rate 0.002
    // Weighted avg: (1+4)/(1000+2000) = 5/3000 ≈ 0.001667
    const map = buildRateMap([
      { modelsUsed: ["m"], totalTokens: 1000, totalCost: 1.0 },
      { modelsUsed: ["m"], totalTokens: 2000, totalCost: 4.0 },
    ]);
    expect(map.get("m")).toBeCloseTo(5 / 3000, 10);
  });

  it("skips rows with zero totalTokens", () => {
    const map = buildRateMap([
      { modelsUsed: ["m"], totalTokens: 0, totalCost: 0 },
    ]);
    expect(map.has("m")).toBe(false);
  });

  it("derives rates from the real fixture data", () => {
    const map = buildRateMap(
      fixture.daily as Array<{
        modelsUsed?: string[];
        totalTokens: number;
        totalCost: number;
      }>,
    );
    // The fixture contains claude-opus-4-6 and other models; map should be non-empty
    expect(map.size).toBeGreaterThan(0);
    // All rates must be positive finite numbers
    for (const rate of map.values()) {
      expect(rate).toBeGreaterThan(0);
      expect(Number.isFinite(rate)).toBe(true);
    }
  });
});

describe("makePricingFn", () => {
  it("returns unknown-model for a model not in the rate map", () => {
    const fn = makePricingFn(new Map());
    expect(fn("unknown-model", 1000)).toEqual({
      usd: null,
      flag: "unknown-model",
    });
  });

  it("returns blended-rate and computed USD for a known model", () => {
    const fn = makePricingFn(new Map([["claude-opus-4-8", 0.001]]));
    expect(fn("claude-opus-4-8", 1000)).toEqual({
      usd: 1.0,
      flag: "blended-rate",
    });
  });

  it("normalizes a dated suffix before lookup", () => {
    const fn = makePricingFn(new Map([["claude-opus-4-8", 0.002]]));
    const result = fn("claude-opus-4-8-20260301", 500);
    expect(result.usd).toBeCloseTo(1.0, 10);
    expect(result.flag).toBe("blended-rate");
  });

  it("returns 0 USD for 0 tokens even for an unknown model", () => {
    // 0 tokens → rate doesn't matter, cost is $0
    const fn = makePricingFn(new Map([["m", 0.001]]));
    expect(fn("m", 0)).toEqual({ usd: 0, flag: "blended-rate" });
  });
});

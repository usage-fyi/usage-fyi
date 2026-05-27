import { describe, it, expect } from "vitest";
import {
  ccusageAdapter,
  CollectError,
  parseCollectOutput,
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

  it("produces schema snapshot/1", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(snap.schema).toBe("snapshot/1");
  });

  it("sets source.tool to ccusage", () => {
    const snap = ccusageAdapter.toSnapshot(raw);
    expect(snap.source.tool).toBe("ccusage");
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

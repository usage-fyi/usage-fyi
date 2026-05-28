import { describe, it, expect } from "vitest";
import { canonicalize } from "../src/canonicalize.js";

describe("canonicalize", () => {
  it("returns 'null' for null", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("delegates primitives to JSON.stringify", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hi")).toBe('"hi"');
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("sorts object keys lexicographically at every depth", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ z: { y: 1, x: 2 }, a: 1 })).toBe(
      '{"a":1,"z":{"x":2,"y":1}}',
    );
  });

  it("produces identical bytes regardless of input key insertion order", () => {
    const a = canonicalize({ x: 1, y: 2, z: { b: 3, a: 4 } });
    const b = canonicalize({ z: { a: 4, b: 3 }, y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("handles nested arrays of objects", () => {
    expect(canonicalize([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe(
      '[{"a":2,"b":1},{"c":4,"d":3}]',
    );
  });

  it("matches a known fixed output for a non-trivial snapshot-like fixture", () => {
    const fixture = {
      schema: "snapshot/2",
      generatedAt: "2026-05-01T00:00:00Z",
      origin: "tool-collected",
      source: {
        tool: "usage-fyi",
        adapter: "ccusage",
        range: ["2026-04-01", "2026-04-30"],
      },
      daily: [
        {
          d: "2026-04-01",
          i: 10,
          o: 20,
          cc: 0,
          cr: 0,
          t: 30,
          c: 0.05,
          m: ["claude-opus-4-7"],
          a: ["claude"],
          mb: [
            {
              a: "claude",
              m: "claude-opus-4-7",
              i: 10,
              o: 20,
              cc: 0,
              cr: 0,
              t: 30,
              c: 0.05,
            },
          ],
        },
      ],
      totals: { i: 10, o: 20, cc: 0, cr: 0, t: 30, c: 0.05 },
      derived: {
        activeDays: 1,
        windows: {
          today: { i: 10, o: 20, cc: 0, cr: 0, t: 30, c: 0.05 },
          d7: { i: 10, o: 20, cc: 0, cr: 0, t: 30, c: 0.05 },
          d30: { i: 10, o: 20, cc: 0, cr: 0, t: 30, c: 0.05 },
          all: { i: 10, o: 20, cc: 0, cr: 0, t: 30, c: 0.05 },
        },
      },
    };
    expect(canonicalize(fixture)).toMatchInlineSnapshot(
      `"{"daily":[{"a":["claude"],"c":0.05,"cc":0,"cr":0,"d":"2026-04-01","i":10,"m":["claude-opus-4-7"],"mb":[{"a":"claude","c":0.05,"cc":0,"cr":0,"i":10,"m":"claude-opus-4-7","o":20,"t":30}],"o":20,"t":30}],"derived":{"activeDays":1,"windows":{"all":{"c":0.05,"cc":0,"cr":0,"i":10,"o":20,"t":30},"d30":{"c":0.05,"cc":0,"cr":0,"i":10,"o":20,"t":30},"d7":{"c":0.05,"cc":0,"cr":0,"i":10,"o":20,"t":30},"today":{"c":0.05,"cc":0,"cr":0,"i":10,"o":20,"t":30}}},"generatedAt":"2026-05-01T00:00:00Z","origin":"tool-collected","schema":"snapshot/2","source":{"adapter":"ccusage","range":["2026-04-01","2026-04-30"],"tool":"usage-fyi"},"totals":{"c":0.05,"cc":0,"cr":0,"i":10,"o":20,"t":30}}"`,
    );
  });
});

import { describe, it, expect } from "vitest";
import { contentHash, hashBytes } from "../src/hash.js";
import type { Snapshot } from "../src/schema.js";

const sample: Snapshot = {
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

describe("contentHash", () => {
  it("is deterministic across calls", async () => {
    const a = await contentHash(sample);
    const b = await contentHash(sample);
    expect(a).toBe(b);
  });

  it("is invariant under key reordering of the input object", async () => {
    const reordered: Snapshot = {
      // Reverse property declaration order; canonicalize sorts keys.
      derived: sample.derived,
      totals: sample.totals,
      daily: sample.daily,
      source: sample.source,
      origin: sample.origin,
      generatedAt: sample.generatedAt,
      schema: "snapshot/2",
    };
    expect(await contentHash(reordered)).toBe(await contentHash(sample));
  });

  it("returns a base64url string (no +, /, or = padding)", async () => {
    const h = await contentHash(sample);
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("matches a known fixed digest for the sample snapshot", async () => {
    // Locks the canonicalize + SHA-256 + base64url pipeline against silent
    // drift. Any change to this value is a wire-contract break (docs/27).
    expect(await contentHash(sample)).toMatchInlineSnapshot(
      `"WoEZ8os7TVpqrexPGF_4Y2kdiX-XiwflLWpvZb7D4Yk"`,
    );
  });
});

describe("hashBytes", () => {
  it("matches a known SHA-256 of the empty input", async () => {
    expect(await hashBytes(new Uint8Array())).toBe(
      "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    );
  });
});

import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/core/index.js";
import { buildHtml } from "../src/preview.js";

const SNAPSHOT: Snapshot = {
  schema: "snapshot/2",
  generatedAt: "2026-05-19T04:00:00Z",
  origin: "tool-collected",
  source: {
    tool: "ccusage",
    adapter: "2",
    range: ["2026-04-19", "2026-05-18"],
  },
  daily: [
    {
      d: "2026-05-18",
      i: 1000,
      o: 500,
      cc: 100,
      cr: 200,
      t: 1800,
      c: 1.5,
      m: ["claude-opus-4-7"],
      a: ["claude"],
      mb: [
        {
          a: "claude",
          m: "claude-opus-4-7",
          i: 1000,
          o: 500,
          cc: 100,
          cr: 200,
          t: 1800,
          c: 1.5,
        },
      ],
    },
  ],
  totals: { i: 1000, o: 500, cc: 100, cr: 200, t: 1800, c: 1.5 },
  derived: {
    activeDays: 1,
    windows: {
      today: { i: 1000, o: 500, cc: 100, cr: 200, t: 1800, c: 1.5 },
      d7: { i: 1000, o: 500, cc: 100, cr: 200, t: 1800, c: 1.5 },
      d30: { i: 1000, o: 500, cc: 100, cr: 200, t: 1800, c: 1.5 },
      all: { i: 1000, o: 500, cc: 100, cr: 200, t: 1800, c: 1.5 },
    },
  },
};

const HTML = buildHtml(SNAPSHOT);

describe("preview page HTML — viewer link", () => {
  it("HTML template includes a viewer-link anchor element", () => {
    expect(HTML).toContain('id="viewer-link"');
  });

  it("viewer-link href is initially # (set by JS after share)", () => {
    expect(HTML).toContain('href="#"');
  });

  it("viewer-link is hidden by default (shown after share succeeds)", () => {
    expect(HTML).toContain('style="display:none"');
  });

  it("viewer-link opens in a new tab", () => {
    expect(HTML).toContain('target="_blank"');
  });

  it("viewer-link has rel=noopener", () => {
    expect(HTML).toContain('rel="noopener"');
  });
});

describe("preview page JS — viewer link populated after share", () => {
  it("sets viewer-link href to url + #mk= fragment after share", () => {
    expect(HTML).toContain("#mk=");
    expect(HTML).toContain("encodeURIComponent(data.manageKey)");
  });

  it("reveals viewer-link after share succeeds", () => {
    expect(HTML).toContain('viewerLink.style.display = ""');
  });

  it("references viewer-link element by id", () => {
    expect(HTML).toContain('"viewer-link"');
  });
});

describe("preview page HTML — card body rendered from snapshot", () => {
  it("includes the local-draft badge text", () => {
    expect(HTML).toContain("local · draft");
  });

  it("includes the source tool in the handle line", () => {
    expect(HTML).toContain("ccusage");
  });
});

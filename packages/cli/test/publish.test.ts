import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_STYLE, slim } from "../src/core/index.js";
import type { RawCcusage, Snapshot, Style } from "../src/core/index.js";
import { run } from "../src/index.js";
import { registerAdapter } from "../src/adapters/registry.js";
import type { UsageAdapter } from "../src/adapters/types.js";
import { PublishError, publishSnapshot } from "../src/publish.js";
import { startTestServer, type TestServer } from "./_helpers/test-server.js";
import fixture from "./fixtures/ccusage-daily.json" with { type: "json" };

const raw = fixture as unknown as RawCcusage;
const testSnapshot: Snapshot = slim(raw, {
  origin: "tool-collected",
  generatedAt: "2026-01-01T00:00:00.000Z",
});
const testStyle: Style = { ...DEFAULT_STYLE };

// ─── publishSnapshot — HTTP contract ─────────────────────────────────────────

describe("publishSnapshot — request body", () => {
  let server: TestServer;
  let lastBody: unknown;

  beforeAll(async () => {
    server = await startTestServer(async (req) => {
      if (req.method === "POST" && req.pathname === "/api/snapshots") {
        lastBody = await req.json();
        return {
          status: 201,
          body: { id: "snap-id-1", manageKey: "mk-abc" },
        };
      }
      return { status: 404, body: "Not Found" };
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("sends exactly { snapshot, style } — no extra keys", async () => {
    await publishSnapshot(testSnapshot, testStyle, server.url);
    const keys = Object.keys(lastBody as Record<string, unknown>).sort();
    expect(keys).toEqual(["snapshot", "style"]);
  });

  it("snapshot value in body matches what was passed", async () => {
    await publishSnapshot(testSnapshot, testStyle, server.url);
    expect((lastBody as { snapshot: Snapshot }).snapshot).toEqual(testSnapshot);
  });

  it("style value in body matches what was passed", async () => {
    await publishSnapshot(testSnapshot, testStyle, server.url);
    expect((lastBody as { style: Style }).style).toEqual(testStyle);
  });

  it("returns { id, manageKey } from a 2xx response", async () => {
    const result = await publishSnapshot(testSnapshot, testStyle, server.url);
    expect(result.id).toBe("snap-id-1");
    expect(result.manageKey).toBe("mk-abc");
  });
});

describe("publishSnapshot — error handling", () => {
  it("throws PublishError on non-2xx", async () => {
    const errServer = await startTestServer(() => ({
      status: 503,
      body: "Service Unavailable",
    }));
    try {
      await expect(
        publishSnapshot(testSnapshot, testStyle, errServer.url),
      ).rejects.toBeInstanceOf(PublishError);
    } finally {
      await errServer.stop();
    }
  });

  it("PublishError carries the HTTP status", async () => {
    const errServer = await startTestServer(() => ({
      status: 400,
      body: "Bad Request",
    }));
    try {
      let caught: unknown;
      try {
        await publishSnapshot(testSnapshot, testStyle, errServer.url);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PublishError);
      expect((caught as PublishError).status).toBe(400);
    } finally {
      await errServer.stop();
    }
  });

  it("PublishError carries the response body", async () => {
    const errServer = await startTestServer(() => ({
      status: 422,
      body: "upstream error detail",
    }));
    try {
      let caught: unknown;
      try {
        await publishSnapshot(testSnapshot, testStyle, errServer.url);
      } catch (e) {
        caught = e;
      }
      expect((caught as PublishError).body).toContain("upstream error detail");
    } finally {
      await errServer.stop();
    }
  });
});

// ─── run() — output format ────────────────────────────────────────────────────

const testAdapter: UsageAdapter = {
  id: "ccusage",
  available: async () => true,
  collect: async () => raw,
  toSnapshot: () => testSnapshot,
};

describe("run() — output format", () => {
  let server: TestServer;

  beforeAll(async () => {
    registerAdapter(testAdapter);
    server = await startTestServer(() => ({
      status: 201,
      body: { id: "out-id", manageKey: "out-key" },
    }));
    process.env.USAGE_FYI_API_BASE = server.url;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.USAGE_FYI_API_BASE;
  });

  it("human output includes the configured /s/<id> URL", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const logged = spy.mock.calls.flat().join("\n");
      expect(logged).toContain(`${server.url}/s/out-id`);
    } finally {
      spy.mockRestore();
    }
  });

  it("human output includes the manageKey", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const logged = spy.mock.calls.flat().join("\n");
      expect(logged).toContain("out-key");
    } finally {
      spy.mockRestore();
    }
  });

  it("human output includes a note that the link is unlisted", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const logged = spy.mock.calls.flat().join("\n");
      expect(logged).toContain("unlisted");
    } finally {
      spy.mockRestore();
    }
  });

  it("human output note mentions the manage key is the only way to delete", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const logged = spy.mock.calls.flat().join("\n");
      expect(logged).toContain("only way to delete");
    } finally {
      spy.mockRestore();
    }
  });

  it("--json emits exactly one line of JSON with { id, url, manageKey, viewerUrl }", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((v: string) => lines.push(v));
    try {
      await run(["--json"]);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(Object.keys(parsed).sort()).toEqual([
        "id",
        "manageKey",
        "url",
        "viewerUrl",
      ]);
      expect(parsed.id).toBe("out-id");
      expect(parsed.url).toBe(`${server.url}/s/out-id`);
      expect(parsed.manageKey).toBe("out-key");
      expect(parsed.viewerUrl).toBe(`${server.url}/s/out-id#mk=out-key`);
    } finally {
      spy.mockRestore();
    }
  });

  it("--json does not emit the unlisted note", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((v: string) => lines.push(v));
    try {
      await run(["--json"]);
      expect(lines).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("snapshot origin in POST body is tool-collected (not recomputed)", async () => {
    let capturedBody: unknown;
    const capturingServer = await startTestServer(async (req) => {
      capturedBody = await req.json();
      return { status: 201, body: { id: "x", manageKey: "y" } };
    });
    process.env.USAGE_FYI_API_BASE = capturingServer.url;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const body = capturedBody as { snapshot: Snapshot };
      expect(body.snapshot.origin).toBe("tool-collected");
    } finally {
      spy.mockRestore();
      await capturingServer.stop();
      process.env.USAGE_FYI_API_BASE = server.url;
    }
  });
});

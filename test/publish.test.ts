import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { DEFAULT_STYLE, slim } from "@usage-fyi/core";
import type { RawCcusage, Snapshot, Style } from "@usage-fyi/core";
import { run } from "../src/index.js";
import { registerAdapter } from "../src/adapters/registry.js";
import type { UsageAdapter } from "../src/adapters/types.js";
import { PublishError, publishSnapshot } from "../src/publish.js";
import fixture from "./fixtures/ccusage-daily.json" with { type: "json" };

const raw = fixture as unknown as RawCcusage;
const testSnapshot: Snapshot = slim(raw, {
  origin: "tool-collected",
  generatedAt: "2026-01-01T00:00:00.000Z",
});
const testStyle: Style = { ...DEFAULT_STYLE };

// ─── publishSnapshot — HTTP contract ─────────────────────────────────────────

describe("publishSnapshot — request body", () => {
  let server: ReturnType<typeof Bun.serve>;
  let lastBody: unknown;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (
          req.method === "POST" &&
          new URL(req.url).pathname === "/api/snapshots"
        ) {
          lastBody = await req.json();
          return new Response(
            JSON.stringify({ id: "snap-id-1", manageKey: "mk-abc" }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  });

  afterAll(() => server.stop());

  it("sends exactly { snapshot, style } — no extra keys", async () => {
    await publishSnapshot(
      testSnapshot,
      testStyle,
      `http://localhost:${server.port}`,
    );
    const keys = Object.keys(lastBody as Record<string, unknown>).sort();
    expect(keys).toEqual(["snapshot", "style"]);
  });

  it("snapshot value in body matches what was passed", async () => {
    await publishSnapshot(
      testSnapshot,
      testStyle,
      `http://localhost:${server.port}`,
    );
    expect((lastBody as { snapshot: Snapshot }).snapshot).toEqual(testSnapshot);
  });

  it("style value in body matches what was passed", async () => {
    await publishSnapshot(
      testSnapshot,
      testStyle,
      `http://localhost:${server.port}`,
    );
    expect((lastBody as { style: Style }).style).toEqual(testStyle);
  });

  it("returns { id, manageKey } from a 2xx response", async () => {
    const result = await publishSnapshot(
      testSnapshot,
      testStyle,
      `http://localhost:${server.port}`,
    );
    expect(result.id).toBe("snap-id-1");
    expect(result.manageKey).toBe("mk-abc");
  });
});

describe("publishSnapshot — error handling", () => {
  it("throws PublishError on non-2xx", async () => {
    const errServer = Bun.serve({
      port: 0,
      fetch: () => new Response("Service Unavailable", { status: 503 }),
    });
    try {
      expect(
        publishSnapshot(
          testSnapshot,
          testStyle,
          `http://localhost:${errServer.port}`,
        ),
      ).rejects.toBeInstanceOf(PublishError);
    } finally {
      errServer.stop();
    }
  });

  it("PublishError carries the HTTP status", async () => {
    const errServer = Bun.serve({
      port: 0,
      fetch: () => new Response("Bad Request", { status: 400 }),
    });
    try {
      let caught: unknown;
      try {
        await publishSnapshot(
          testSnapshot,
          testStyle,
          `http://localhost:${errServer.port}`,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PublishError);
      expect((caught as PublishError).status).toBe(400);
    } finally {
      errServer.stop();
    }
  });

  it("PublishError carries the response body", async () => {
    const errServer = Bun.serve({
      port: 0,
      fetch: () => new Response("upstream error detail", { status: 422 }),
    });
    try {
      let caught: unknown;
      try {
        await publishSnapshot(
          testSnapshot,
          testStyle,
          `http://localhost:${errServer.port}`,
        );
      } catch (e) {
        caught = e;
      }
      expect((caught as PublishError).body).toContain("upstream error detail");
    } finally {
      errServer.stop();
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
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    registerAdapter(testAdapter);
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ id: "out-id", manageKey: "out-key" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    });
    process.env.USAGE_FYI_API_BASE = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop();
    delete process.env.USAGE_FYI_API_BASE;
  });

  it("human output includes the configured /s/<id> URL", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const logged = spy.mock.calls.flat().join("\n");
      expect(logged).toContain(`http://localhost:${server.port}/s/out-id`);
    } finally {
      spy.mockRestore();
    }
  });

  it("human output includes the manageKey", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const logged = spy.mock.calls.flat().join("\n");
      expect(logged).toContain("out-key");
    } finally {
      spy.mockRestore();
    }
  });

  it("human output includes a note that the link is unlisted", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const logged = spy.mock.calls.flat().join("\n");
      expect(logged).toContain("unlisted");
    } finally {
      spy.mockRestore();
    }
  });

  it("human output note mentions the manage key is the only way to delete", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
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
    const spy = spyOn(console, "log").mockImplementation((v: string) =>
      lines.push(v),
    );
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
      expect(parsed.url).toBe(`http://localhost:${server.port}/s/out-id`);
      expect(parsed.manageKey).toBe("out-key");
      expect(parsed.viewerUrl).toBe(
        `http://localhost:${server.port}/s/out-id#mk=out-key`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("--json does not emit the unlisted note", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((v: string) =>
      lines.push(v),
    );
    try {
      await run(["--json"]);
      expect(lines).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("snapshot origin in POST body is tool-collected (not recomputed)", async () => {
    let capturedBody: unknown;
    const capturingServer = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.json();
        return new Response(JSON.stringify({ id: "x", manageKey: "y" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    process.env.USAGE_FYI_API_BASE = `http://localhost:${capturingServer.port}`;
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
      const body = capturedBody as { snapshot: Snapshot };
      expect(body.snapshot.origin).toBe("tool-collected");
    } finally {
      spy.mockRestore();
      capturingServer.stop();
      process.env.USAGE_FYI_API_BASE = `http://localhost:${server.port}`;
    }
  });
});

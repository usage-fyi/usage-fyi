/**
 * End-to-end acceptance tests for the thin publish CLI (T0040).
 * Covers: full flow, profile/token rejection, determinism, no-telemetry guard,
 * and a source-tree assertion that no forbidden modules exist.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { slim, contentHash } from "../src/core/index.js";
import type { RawCcusage, Snapshot } from "../src/core/index.js";
import { run } from "../src/index.js";
import { registerAdapter } from "../src/adapters/registry.js";
import type { UsageAdapter } from "../src/adapters/types.js";
import { EXIT } from "../src/errors.js";
import { startTestServer, type TestServer } from "./_helpers/test-server.js";
import fixture from "./fixtures/ccusage-daily.json" with { type: "json" };
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const raw = fixture as unknown as RawCcusage;
const FIXED_TS = "2026-01-01T00:00:00.000Z";
const testSnapshot = slim(raw, {
  origin: "tool-collected",
  generatedAt: FIXED_TS,
});

const testAdapter: UsageAdapter = {
  id: "ccusage",
  available: async () => true,
  collect: async () => raw,
  toSnapshot: () => testSnapshot,
};

/** Run CLI with the given adapter registered; returns exit code and captured output. */
async function runFull(
  argv: string[],
  apiBase: string,
  adapter: UsageAdapter = testAdapter,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  registerAdapter(adapter);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) =>
      stdout.push(args.map(String).join(" ")),
    );
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) =>
      stderr.push(args.map(String).join(" ")),
    );
  process.env.USAGE_FYI_API_BASE = apiBase;
  let code: number;
  try {
    code = await run(argv);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    delete process.env.USAGE_FYI_API_BASE;
  }
  return { code, stdout, stderr };
}

// ─── Full success path ─────────────────────────────────────────────────────────

describe("full publish flow — success path", () => {
  let capturedBody: unknown;
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(async (req) => {
      if (req.method === "POST" && req.pathname === "/api/snapshots") {
        capturedBody = await req.json();
        return {
          status: 201,
          body: { id: "accept-id", manageKey: "accept-key" },
        };
      }
      return { status: 404, body: "Not Found" };
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("returns exit code OK", async () => {
    const { code } = await runFull(["--no-open"], server.url);
    expect(code).toBe(EXIT.OK);
  });

  it("prints the configured /s/<id> URL", async () => {
    const { stdout } = await runFull(["--no-open"], server.url);
    expect(stdout.join("\n")).toContain(`${server.url}/s/accept-id`);
  });

  it("prints the manageKey", async () => {
    const { stdout } = await runFull(["--no-open"], server.url);
    expect(stdout.join("\n")).toContain("accept-key");
  });

  it("printed snapshot origin is tool-collected", async () => {
    await runFull(["--no-open"], server.url);
    expect((capturedBody as { snapshot: Snapshot }).snapshot.origin).toBe(
      "tool-collected",
    );
  });

  it("POST body has exactly { snapshot, style } keys", async () => {
    await runFull(["--no-open"], server.url);
    const keys = Object.keys(capturedBody as Record<string, unknown>).sort();
    expect(keys).toEqual(["snapshot", "style"]);
  });
});

// ─── --profile / --token rejection ───────────────────────────────────────────

describe("--profile and --token are rejected (later-phase)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(() => ({
      status: 201,
      body: { id: "x", manageKey: "y" },
    }));
  });

  afterAll(async () => {
    await server.stop();
  });

  it("--profile exits with ARGS code", async () => {
    const { code } = await runFull(["--profile", "alice"], server.url);
    expect(code).toBe(EXIT.ARGS);
  });

  it("--profile message mentions later phase", async () => {
    const { stderr } = await runFull(["--profile", "alice"], server.url);
    expect(stderr.join("\n").toLowerCase()).toContain("later phase");
  });

  it("--token exits with ARGS code", async () => {
    const { code } = await runFull(["--token", "tok123"], server.url);
    expect(code).toBe(EXIT.ARGS);
  });

  it("--token message mentions later phase", async () => {
    const { stderr } = await runFull(["--token", "tok123"], server.url);
    expect(stderr.join("\n").toLowerCase()).toContain("later phase");
  });
});

// ─── Determinism ──────────────────────────────────────────────────────────────

describe("snapshot determinism", () => {
  it("same fixture + same generatedAt → identical contentHash", async () => {
    const snap1 = slim(raw, {
      origin: "tool-collected",
      generatedAt: FIXED_TS,
    });
    const snap2 = slim(raw, {
      origin: "tool-collected",
      generatedAt: FIXED_TS,
    });
    const [hash1, hash2] = await Promise.all([
      contentHash(snap1),
      contentHash(snap2),
    ]);
    expect(hash1).toBe(hash2);
    expect(hash1).toBeTruthy();
  });

  it("different generatedAt → different contentHash", async () => {
    const snap1 = slim(raw, {
      origin: "tool-collected",
      generatedAt: FIXED_TS,
    });
    const snap2 = slim(raw, {
      origin: "tool-collected",
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    const [hash1, hash2] = await Promise.all([
      contentHash(snap1),
      contentHash(snap2),
    ]);
    expect(hash1).not.toBe(hash2);
  });

  it("running through a mock adapter twice produces the same POST body", async () => {
    const bodies: Snapshot[] = [];
    const server = await startTestServer(async (req) => {
      if (req.method === "POST") {
        const b = (await req.json()) as { snapshot: Snapshot };
        bodies.push(b.snapshot);
      }
      return { status: 201, body: { id: "d-id", manageKey: "d-key" } };
    });
    // Use fixed-timestamp adapter so both runs are identical
    const fixedAdapter: UsageAdapter = {
      id: "ccusage",
      available: async () => true,
      collect: async () => raw,
      toSnapshot: () =>
        slim(raw, { origin: "tool-collected", generatedAt: FIXED_TS }),
    };
    try {
      await runFull(["--no-open"], server.url, fixedAdapter);
      await runFull(["--no-open"], server.url, fixedAdapter);
      expect(bodies).toHaveLength(2);
      const [h1, h2] = await Promise.all([
        contentHash(bodies[0]!),
        contentHash(bodies[1]!),
      ]);
      expect(h1).toBe(h2);
    } finally {
      await server.stop();
    }
  });
});

// ─── No-telemetry guard ────────────────────────────────────────────────────────

describe("no-telemetry guard — exactly one outbound HTTP call", () => {
  let requests: Array<{ method: string; path: string }> = [];
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((req) => {
      requests.push({ method: req.method, path: req.pathname });
      if (req.method === "POST" && req.pathname === "/api/snapshots") {
        return {
          status: 201,
          body: { id: "tele-id", manageKey: "tele-key" },
        };
      }
      return { status: 404, body: "Not Found" };
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("full flow makes exactly one HTTP request", async () => {
    requests = [];
    await runFull(["--no-open"], server.url);
    expect(requests).toHaveLength(1);
  });

  it("that single request is POST /api/snapshots", async () => {
    requests = [];
    await runFull(["--no-open"], server.url);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe("/api/snapshots");
  });
});

// ─── Source-tree assertion ─────────────────────────────────────────────────────

describe("source-tree — no forbidden modules in cli/src", () => {
  const srcDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src",
  );

  /** Recursively list all .ts files under a directory, skipping vendored core. */
  function listTs(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Vendored zero-dep schema/utility module — not CLI surface.
        if (e.name === "core") return [];
        return listTs(full);
      }
      if (e.isFile() && e.name.endsWith(".ts")) return [full];
      return [];
    });
  }

  const srcFiles = listTs(srcDir);
  const allSource = srcFiles.map((f) => readFileSync(f, "utf-8")).join("\n");

  it("no offline HTML generation code exists", () => {
    const files = srcFiles.filter((f) =>
      /offline|html.?gen|render.?html/i.test(path.basename(f)),
    );
    expect(files).toHaveLength(0);
  });

  it("no MCP tool module exists", () => {
    const files = srcFiles.filter((f) => /mcp/i.test(path.basename(f)));
    expect(files).toHaveLength(0);
  });

  it("no identity or profile module exists", () => {
    const files = srcFiles.filter((f) =>
      /identity|profile|account|claim/i.test(path.basename(f)),
    );
    expect(files).toHaveLength(0);
  });

  it("no analytics or telemetry module exists", () => {
    const files = srcFiles.filter((f) =>
      /analytics|telemetry|segment|mixpanel|posthog|amplitude/i.test(
        path.basename(f),
      ),
    );
    expect(files).toHaveLength(0);
  });

  it("source imports no analytics SDK", () => {
    const analyticsPattern =
      /import.*["'](segment|mixpanel|posthog|amplitude|@segment|rudderstack)/;
    expect(analyticsPattern.test(allSource)).toBe(false);
  });

  it("source imports no MCP SDK", () => {
    // Accepts hypothetical mcp package names
    const mcpPattern = /import.*["']@modelcontextprotocol|import.*["']mcp-/;
    expect(mcpPattern.test(allSource)).toBe(false);
  });

  it("source has no phone-home fetch calls outside publish.ts", () => {
    // Every fetch in the codebase should be in publish.ts (the publish POST).
    // Check that no other .ts file contains a fetch() call.
    // preview.ts ships a fetch() literal as inline browser JS (call to its own
    // local /share endpoint) — that is not a runtime CLI phone-home.
    const allowedFetchFiles = new Set(["publish.ts", "preview.ts"]);
    const nonPublishFiles = srcFiles.filter(
      (f) => !allowedFetchFiles.has(path.basename(f)),
    );
    const fetchInNonPublish = nonPublishFiles.filter((f) => {
      const src = readFileSync(f, "utf-8");
      return /\bfetch\s*\(/.test(src);
    });
    expect(fetchInNonPublish).toHaveLength(0);
  });

  it("no collector token or auth token handling beyond args rejection", () => {
    // The only place 'token' should appear is in args.ts (rejection) and index.ts (routing to rejection).
    // No other file should contain token auth logic.
    const tokenFiles = srcFiles.filter((f) => {
      const basename = path.basename(f);
      if (basename === "args.ts" || basename === "index.ts") return false;
      const src = readFileSync(f, "utf-8");
      return /bearer|authorization.*header|collector.?token/i.test(src);
    });
    expect(tokenFiles).toHaveLength(0);
  });
});

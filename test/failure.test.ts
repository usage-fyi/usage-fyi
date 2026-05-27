import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { slim } from "@usage-fyi/core";
import type { RawCcusage } from "@usage-fyi/core";
import { run } from "../src/index.js";
import { registerAdapter } from "../src/adapters/registry.js";
import type { UsageAdapter } from "../src/adapters/types.js";
import { CollectError } from "../src/adapters/ccusage.js";
import { EXIT, resolvePublishError } from "../src/errors.js";
import fixture from "./fixtures/ccusage-daily.json" with {
  type: "json",
};

const raw = fixture as unknown as RawCcusage;
const testSnapshot = slim(raw, {
  origin: "tool-collected",
  generatedAt: "2026-01-01T00:00:00.000Z",
});

const successAdapter: UsageAdapter = {
  id: "ccusage",
  available: async () => true,
  collect: async () => raw,
  toSnapshot: () => testSnapshot,
};

const unavailableAdapter: UsageAdapter = {
  id: "ccusage",
  available: async () => false,
  collect: async () => raw,
  toSnapshot: () => testSnapshot,
};

const collectFailAdapter: UsageAdapter = {
  id: "ccusage",
  available: async () => true,
  collect: async () => {
    throw new CollectError("ccusage exited with code 1", "some stderr", 1);
  },
  toSnapshot: () => testSnapshot,
};

/**
 * Register adapter, set apiBase env, run CLI, restore.
 * Returns { code, errors } — adapter registration is inlined so the registry
 * is always in the right state regardless of describe-block ordering.
 */
async function runWith(
  argv: string[],
  apiBase: string,
  adapter: UsageAdapter,
): Promise<{ code: number; errors: string[] }> {
  registerAdapter(adapter);
  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => errors.push(args.map(String).join(" ")),
  );
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  process.env.USAGE_FYI_API_BASE = apiBase;
  let code: number;
  try {
    code = await run(argv);
  } finally {
    errSpy.mockRestore();
    logSpy.mockRestore();
    delete process.env.USAGE_FYI_API_BASE;
  }
  return { code, errors };
}

// ─── resolvePublishError — unit ───────────────────────────────────────────────

describe("resolvePublishError", () => {
  it("maps rate_limited to a retryable message", () => {
    const info = resolvePublishError(
      429,
      JSON.stringify({ error: { code: "rate_limited" } }),
    );
    expect(info.retryable).toBe(true);
    expect(info.message).toContain("Rate limited");
  });

  it("maps invalid_schema to non-retryable with validation message", () => {
    const info = resolvePublishError(
      400,
      JSON.stringify({ error: { code: "invalid_schema" } }),
    );
    expect(info.retryable).toBe(false);
    expect(info.message).toContain("validation");
  });

  it("maps payload_too_large to non-retryable", () => {
    const info = resolvePublishError(
      413,
      JSON.stringify({ error: { code: "payload_too_large" } }),
    );
    expect(info.retryable).toBe(false);
  });

  it("5xx without known code → retryable with retry message", () => {
    const info = resolvePublishError(503, "Service Unavailable");
    expect(info.retryable).toBe(true);
    expect(info.message).toContain("retry is safe");
  });

  it("4xx with non-JSON body → not retryable", () => {
    const info = resolvePublishError(400, "bad request");
    expect(info.retryable).toBe(false);
  });

  it("5xx with non-JSON body → retryable fallback", () => {
    const info = resolvePublishError(500, "not json at all");
    expect(info.retryable).toBe(true);
  });

  it("unknown hosted error code falls through to HTTP status logic", () => {
    const info = resolvePublishError(
      400,
      JSON.stringify({ error: { code: "completely_unknown_code" } }),
    );
    expect(info.retryable).toBe(false);
  });
});

// ─── adapter unavailable — no partial publish ─────────────────────────────────

describe("adapter unavailable — no partial publish", () => {
  let requestCount = 0;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => {
        requestCount++;
        return new Response(JSON.stringify({ id: "x", manageKey: "y" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
  });

  beforeEach(() => {
    requestCount = 0;
  });

  afterAll(() => server.stop());

  it("returns ADAPTER exit code", async () => {
    const { code } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      unavailableAdapter,
    );
    expect(code).toBe(EXIT.ADAPTER);
  });

  it("makes no HTTP requests before exiting", async () => {
    await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      unavailableAdapter,
    );
    expect(requestCount).toBe(0);
  });

  it("prints an actionable install message", async () => {
    const { errors } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      unavailableAdapter,
    );
    expect(errors.join("\n").toLowerCase()).toMatch(/install|not installed/);
  });
});

// ─── collect error — no partial publish ──────────────────────────────────────

describe("collect error — no partial publish", () => {
  let requestCount = 0;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => {
        requestCount++;
        return new Response(JSON.stringify({ id: "x", manageKey: "y" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
  });

  beforeEach(() => {
    requestCount = 0;
  });

  afterAll(() => server.stop());

  it("returns ADAPTER exit code", async () => {
    const { code } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      collectFailAdapter,
    );
    expect(code).toBe(EXIT.ADAPTER);
  });

  it("makes no HTTP requests before exiting", async () => {
    await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      collectFailAdapter,
    );
    expect(requestCount).toBe(0);
  });

  it("prints the collect error message", async () => {
    const { errors } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      collectFailAdapter,
    );
    expect(errors.join("\n")).toContain("collecting");
  });
});

// ─── publish failure — HTTP error ────────────────────────────────────────────

describe("publish failure — rate_limited (429)", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            error: { code: "rate_limited", message: "slow down" },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
    });
  });

  afterAll(() => server.stop());

  it("returns PUBLISH exit code", async () => {
    const { code } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      successAdapter,
    );
    expect(code).toBe(EXIT.PUBLISH);
  });

  it("prints the rate_limited message", async () => {
    const { errors } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      successAdapter,
    );
    expect(errors.join("\n")).toContain("Rate limited");
  });

  it("tells the user retry is safe", async () => {
    const { errors } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      successAdapter,
    );
    expect(errors.join("\n").toLowerCase()).toContain("retry");
  });
});

describe("publish failure — 5xx server error", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response("Internal Server Error", { status: 503 }),
    });
  });

  afterAll(() => server.stop());

  it("returns PUBLISH exit code", async () => {
    const { code } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      successAdapter,
    );
    expect(code).toBe(EXIT.PUBLISH);
  });

  it("message says retry is safe", async () => {
    const { errors } = await runWith(
      ["--no-open"],
      `http://localhost:${server.port}`,
      successAdapter,
    );
    expect(errors.join("\n").toLowerCase()).toContain("retry");
  });
});

describe("publish failure — network error (unreachable host)", () => {
  it("returns PUBLISH exit code on connection refused", async () => {
    const { code } = await runWith(
      ["--no-open"],
      "http://127.0.0.1:1",
      successAdapter,
    );
    expect(code).toBe(EXIT.PUBLISH);
  });

  it("prints a connection/retry message", async () => {
    const { errors } = await runWith(
      ["--no-open"],
      "http://127.0.0.1:1",
      successAdapter,
    );
    expect(errors.join("\n").toLowerCase()).toMatch(/connect|reach|network/);
  });

  it("retry-safe message on network failure", async () => {
    const { errors } = await runWith(
      ["--no-open"],
      "http://127.0.0.1:1",
      successAdapter,
    );
    expect(errors.join("\n").toLowerCase()).toContain("retry");
  });
});

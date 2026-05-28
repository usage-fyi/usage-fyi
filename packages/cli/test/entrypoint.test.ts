import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { slim } from "../src/core/index.js";
import type { RawCcusage } from "../src/core/index.js";
import { run } from "../src/index.js";
import { registerAdapter } from "../src/adapters/registry.js";
import type { UsageAdapter } from "../src/adapters/types.js";
import { startTestServer, type TestServer } from "./_helpers/test-server.js";
import fixture from "./fixtures/ccusage-daily.json" with { type: "json" };

const raw = fixture as unknown as RawCcusage;
const testSnapshot = slim(raw, {
  origin: "tool-collected",
  generatedAt: "2026-01-01T00:00:00.000Z",
});

const stubAdapter: UsageAdapter = {
  id: "ccusage",
  available: async () => true,
  collect: async () => raw,
  toSnapshot: () => testSnapshot,
};

let server: TestServer;

beforeAll(async () => {
  registerAdapter(stubAdapter);
  server = await startTestServer(() => ({
    status: 201,
    body: { id: "ep-id", manageKey: "ep-key" },
  }));
  process.env.USAGE_FYI_API_BASE = server.url;
});

afterAll(async () => {
  await server.stop();
  delete process.env.USAGE_FYI_API_BASE;
});

describe("usage-fyi entrypoint", () => {
  it("run() with no args resolves without error", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("run() with --json resolves without error", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--json"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("run() with --no-open resolves without error", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
    } finally {
      spy.mockRestore();
    }
  });
});

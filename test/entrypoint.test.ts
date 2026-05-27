import { afterAll, beforeAll, describe, it, spyOn } from "bun:test";
import { slim } from "@usage-fyi/core";
import type { RawCcusage } from "@usage-fyi/core";
import { run } from "../src/index";
import { registerAdapter } from "../src/adapters/registry";
import type { UsageAdapter } from "../src/adapters/types";
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

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  registerAdapter(stubAdapter);
  server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ id: "ep-id", manageKey: "ep-key" }), {
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

describe("@usage-fyi/cli entrypoint", () => {
  it("run() with no args resolves without error", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("run() with --json resolves without error", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--json"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("run() with --no-open resolves without error", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await run(["--no-open"]);
    } finally {
      spy.mockRestore();
    }
  });
});

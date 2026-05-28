import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configPath,
  loadConfig,
  redact,
  resolveSettings,
  saveConfig,
} from "../src/config";
import { DEFAULT_SOURCE } from "../src/adapters/registry";

// ─── helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-fyi-test-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(async () => {
  delete process.env.XDG_CONFIG_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── configPath ───────────────────────────────────────────────────────────────

describe("configPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    const p = configPath();
    expect(p).toContain(tmpDir);
    expect(p).toContain("usage-fyi");
    expect(p.endsWith("config.json")).toBe(true);
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    const p = configPath();
    expect(p).toContain(".config");
    expect(p).toContain("usage-fyi");
    expect(p.endsWith("config.json")).toBe(true);
  });
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

describe("loadConfig — missing file", () => {
  it("returns {} when config file does not exist", async () => {
    const config = await loadConfig();
    expect(config).toEqual({});
  });
});

describe("loadConfig — malformed JSON", () => {
  it("throws an error when the file contains invalid JSON", async () => {
    const p = configPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "{ not valid json", "utf-8");
    await expect(loadConfig()).rejects.toThrow(/malformed JSON/i);
  });
});

describe("loadConfig — valid file", () => {
  it("parses apiBase from config", async () => {
    const p = configPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(
      p,
      JSON.stringify({ apiBase: "https://staging.usage.fyi" }),
      "utf-8",
    );
    const config = await loadConfig();
    expect(config.apiBase).toBe("https://staging.usage.fyi");
  });
});

// ─── saveConfig ───────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  it("creates the config file", async () => {
    await saveConfig({ apiBase: "https://staging.usage.fyi" });
    const p = configPath();
    const text = await fs.readFile(p, "utf-8");
    expect(JSON.parse(text).apiBase).toBe("https://staging.usage.fyi");
  });

  it("creates parent directories if they do not exist", async () => {
    await saveConfig({ source: "ccusage" });
    const p = configPath();
    const stat = await fs.stat(p);
    expect(stat.isFile()).toBe(true);
  });

  it("writes the file with mode 0o600", async () => {
    await saveConfig({ source: "ccusage" });
    const p = configPath();
    const stat = await fs.stat(p);
    // On POSIX: mask to permission bits only
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips config through saveConfig then loadConfig", async () => {
    const original = {
      source: "ccusage",
      apiBase: "https://staging.usage.fyi",
    };
    await saveConfig(original);
    const loaded = await loadConfig();
    expect(loaded.source).toBe("ccusage");
    expect(loaded.apiBase).toBe("https://staging.usage.fyi");
  });
});

// ─── redact ───────────────────────────────────────────────────────────────────

describe("redact", () => {
  it("replaces values whose keys contain 'token'", () => {
    const out = redact({ apiToken: "abc123" });
    expect(out["apiToken"]).toBe("[REDACTED]");
  });

  it("replaces values whose keys contain 'secret'", () => {
    const out = redact({ clientSecret: "s3cr3t" });
    expect(out["clientSecret"]).toBe("[REDACTED]");
  });

  it("replaces values whose keys contain 'password'", () => {
    const out = redact({ password: "hunter2" });
    expect(out["password"]).toBe("[REDACTED]");
  });

  it("replaces values whose keys contain 'key' (case-insensitive)", () => {
    const out = redact({ apiKey: "k-xyz" });
    expect(out["apiKey"]).toBe("[REDACTED]");
  });

  it("replaces values whose keys contain 'credential'", () => {
    const out = redact({ credential: "cred-val" });
    expect(out["credential"]).toBe("[REDACTED]");
  });

  it("preserves values whose keys are not secret-shaped", () => {
    const out = redact({ source: "ccusage", apiBase: "https://x" });
    expect(out["source"]).toBe("ccusage");
    expect(out["apiBase"]).toBe("https://x");
  });

  it("never leaks a token-shaped value verbatim in JSON.stringify output", () => {
    const secret = "tok_super_secret_value_9999";
    const obj = { apiToken: secret, source: "ccusage" };
    const redacted = redact(obj);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });
});

// ─── resolveSettings ─────────────────────────────────────────────────────────

const baseFlags = {
  source: DEFAULT_SOURCE,
} as const;

describe("resolveSettings — built-in defaults", () => {
  it("source defaults to DEFAULT_SOURCE", () => {
    const s = resolveSettings(baseFlags, {});
    expect(s.source).toBe(DEFAULT_SOURCE);
  });

  it("apiBase defaults to https://usage.fyi", () => {
    const s = resolveSettings(baseFlags, {});
    expect(s.apiBase).toBe("https://usage.fyi");
  });
});

describe("resolveSettings — config overrides defaults", () => {
  it("config.apiBase overrides default", () => {
    const s = resolveSettings(baseFlags, {
      apiBase: "https://staging.example.com",
    });
    expect(s.apiBase).toBe("https://staging.example.com");
  });
});

// ─── Secret-safe diagnostic discipline ───────────────────────────────────────

describe("secret-safe diagnostic discipline", () => {
  it("a token-shaped config value never appears verbatim in console output", () => {
    const secretValue = "tok_abc123_SENSITIVE";
    const captured: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) =>
        captured.push(args.map(String).join(" ")),
      );
    try {
      // Simulate logging a redacted config for diagnostics
      const configWithSecret = { apiToken: secretValue, source: "ccusage" };
      console.log(JSON.stringify(redact(configWithSecret)));
    } finally {
      spy.mockRestore();
    }
    const output = captured.join("\n");
    expect(output).not.toContain(secretValue);
    expect(output).toContain("[REDACTED]");
  });
});

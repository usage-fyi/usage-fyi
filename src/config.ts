import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { DEFAULT_SOURCE } from "./adapters/registry.js";

const PRODUCTION_API = "https://usage.fyi";

const SECRET_KEY_RE = /token|secret|key|password|credential/i;

/** Shape stored in the local config file */
export interface LocalConfig {
  source?: string;
  apiBase?: string;
}

/** Fully-resolved settings after applying flags > config > built-in defaults */
export interface ResolvedSettings {
  source: string;
  apiBase: string;
}

/** Minimum flag shape needed for settings resolution */
interface SourceFlags {
  source: string;
}

/** XDG-aware config file path */
export function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "usage-fyi", "config.json");
}

/**
 * Load local config. Returns {} on missing file; throws on malformed JSON.
 */
export async function loadConfig(): Promise<LocalConfig> {
  const p = configPath();
  let text: string;
  try {
    text = await fs.readFile(p, "utf-8");
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: unknown }).code === "ENOENT"
    )
      return {};
    throw err;
  }
  try {
    return JSON.parse(text) as LocalConfig;
  } catch {
    throw new Error(`Config at ${p} contains malformed JSON`);
  }
}

/**
 * Persist config to disk with restricted permissions (0600).
 * Creates the directory if needed.
 */
export async function saveConfig(config: LocalConfig): Promise<void> {
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Redact any value whose key matches a token/secret pattern.
 * Call this before logging any config-derived object in diagnostic output.
 */
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

/**
 * Merge flags > config > built-in defaults into a fully-resolved settings object.
 */
export function resolveSettings(
  flags: SourceFlags,
  config: LocalConfig,
): ResolvedSettings {
  return {
    source: flags.source ?? config.source ?? DEFAULT_SOURCE,
    apiBase: config.apiBase ?? PRODUCTION_API,
  };
}

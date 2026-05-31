#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  HelpRequestedError,
  LaterPhaseError,
  VersionRequestedError,
  parseArgs,
} from "./args.js";
import { loadConfig, resolveSettings } from "./config.js";
import { buildStyle } from "./style.js";
import { getAdapter, registerAdapter } from "./adapters/registry.js";
import { ccusageAdapter, CollectError } from "./adapters/ccusage.js";
import { publishSnapshot, PublishError } from "./publish.js";
import { EXIT, resolvePublishError } from "./errors.js";
import { openBrowser } from "./open.js";
import { runPreview } from "./preview.js";

registerAdapter(ccusageAdapter);

/**
 * Main entry point. Returns an exit code so tests can assert it without
 * mocking process.exit. The bin entry calls process.exit(await run(...)).
 */
export async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof HelpRequestedError) {
      console.log(err.text);
      return EXIT.OK;
    }
    if (err instanceof VersionRequestedError) {
      console.log(err.version);
      return EXIT.OK;
    }
    if (err instanceof LaterPhaseError) {
      console.error(err.message);
      return EXIT.ARGS;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return EXIT.ARGS;
  }

  const config = await loadConfig();
  const settings = resolveSettings(parsed, config);
  const style = buildStyle(settings);

  let adapter;
  try {
    adapter = getAdapter(parsed.source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return EXIT.ARGS;
  }

  const isAvailable = await adapter.available();
  if (!isAvailable) {
    console.error(`Error: ${parsed.source} failed to launch.`);
    console.error(
      `  ccusage ships as a dependency of usage-fyi — this usually means a broken install.`,
    );
    console.error(`  Try reinstalling: bunx usage-fyi@latest`);
    return EXIT.ADAPTER;
  }

  let raw: unknown;
  try {
    raw = await adapter.collect({});
  } catch (err) {
    if (err instanceof CollectError) {
      console.error(`Error collecting usage data: ${err.message}`);
      if (err.stderr) console.error(err.stderr.trim());
      return EXIT.ADAPTER;
    }
    throw err;
  }

  const snapshot = adapter.toSnapshot(raw);

  const apiBase = process.env.USAGE_FYI_API_BASE ?? settings.apiBase;

  if (parsed.preview) {
    await runPreview(snapshot, style, apiBase);
    return EXIT.OK;
  }

  try {
    const { id, manageKey } = await publishSnapshot(snapshot, style, apiBase);

    const url = `${apiBase}/s/${id}`;
    const viewerUrl = `${url}#mk=${encodeURIComponent(manageKey)}`;

    if (parsed.json) {
      console.log(JSON.stringify({ id, url, manageKey, viewerUrl }));
    } else {
      console.log(`${url}#mk=${encodeURIComponent(manageKey)}`);
      if (parsed.open) {
        await openBrowser(viewerUrl);
      }
    }
  } catch (err) {
    if (err instanceof PublishError) {
      const { message, retryable } = resolvePublishError(err.status, err.body);
      console.error(`Error: ${message}`);
      if (retryable) {
        console.error("Nothing was corrupted — retry is safe.");
      }
      return EXIT.PUBLISH;
    }
    // Network errors: TypeError (standard fetch) or Bun native errors with a code property
    if (
      err instanceof TypeError ||
      (err instanceof Error &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string")
    ) {
      console.error(
        "Error: Could not reach usage.fyi — check your connection. Nothing was published, retry is safe.",
      );
      return EXIT.PUBLISH;
    }
    throw err;
  }

  return EXIT.OK;
}

const invokedAs = process.argv[1];
if (
  invokedAs &&
  pathToFileURL(realpathSync(invokedAs)).href === import.meta.url
) {
  process.exit(await run(process.argv.slice(2)));
}

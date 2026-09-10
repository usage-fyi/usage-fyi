import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  HelpRequestedError,
  LaterPhaseError,
  VersionRequestedError,
  parseArgs,
} from "../src/args";
import { DEFAULT_SOURCE } from "../src/adapters/registry";

describe("parseArgs — defaults", () => {
  it("source defaults to DEFAULT_SOURCE", () => {
    expect(parseArgs([]).source).toBe(DEFAULT_SOURCE);
  });

  it("json is false by default", () => {
    expect(parseArgs([]).json).toBe(false);
  });

  it("open is true by default", () => {
    expect(parseArgs([]).open).toBe(true);
  });

  it("preview is false by default", () => {
    expect(parseArgs([]).preview).toBe(false);
  });

  it("command defaults to publish", () => {
    expect(parseArgs([]).command).toBe("publish");
  });
});

describe("parseArgs — boolean flags", () => {
  it("--json sets json to true", () => {
    expect(parseArgs(["--json"]).json).toBe(true);
  });

  it("--no-open sets open to false", () => {
    expect(parseArgs(["--no-open"]).open).toBe(false);
  });

  it("--preview sets preview to true", () => {
    expect(parseArgs(["--preview"]).preview).toBe(true);
  });
});

describe("parseArgs — --source", () => {
  it("accepts a custom source", () => {
    expect(parseArgs(["--source", "custom"]).source).toBe("custom");
  });
});

describe("parseArgs — removed style flags treated as unknown", () => {
  it("--design is rejected as an unknown flag", () => {
    expect(() => parseArgs(["--design", "stream"])).toThrow(/Unknown flag/);
  });

  it("--theme is rejected as an unknown flag", () => {
    expect(() => parseArgs(["--theme", "dark"])).toThrow(/Unknown flag/);
  });

  it("--format is rejected as an unknown flag", () => {
    expect(() => parseArgs(["--format", "wide"])).toThrow(/Unknown flag/);
  });
});

describe("parseArgs — --profile and --token rejection", () => {
  it("--profile throws LaterPhaseError", () => {
    expect(() => parseArgs(["--profile"])).toThrow(LaterPhaseError);
  });

  it("--token throws LaterPhaseError", () => {
    expect(() => parseArgs(["--token"])).toThrow(LaterPhaseError);
  });

  it("LaterPhaseError message for --profile mentions later phase", () => {
    let err: unknown;
    try {
      parseArgs(["--profile"]);
    } catch (e) {
      err = e;
    }
    expect((err as LaterPhaseError).message).toContain("later phase");
  });

  it("LaterPhaseError message for --token mentions later phase", () => {
    let err: unknown;
    try {
      parseArgs(["--token"]);
    } catch (e) {
      err = e;
    }
    expect((err as LaterPhaseError).message).toContain("later phase");
  });

  it("LaterPhaseError carries the flag name for --profile", () => {
    let err: unknown;
    try {
      parseArgs(["--profile"]);
    } catch (e) {
      err = e;
    }
    expect((err as LaterPhaseError).flag).toBe("--profile");
  });

  it("LaterPhaseError carries the flag name for --token", () => {
    let err: unknown;
    try {
      parseArgs(["--token"]);
    } catch (e) {
      err = e;
    }
    expect((err as LaterPhaseError).flag).toBe("--token");
  });
});

describe("parseArgs — --help", () => {
  it("throws HelpRequestedError", () => {
    expect(() => parseArgs(["--help"])).toThrow(HelpRequestedError);
  });

  it("-h throws HelpRequestedError", () => {
    expect(() => parseArgs(["-h"])).toThrow(HelpRequestedError);
  });

  it("HelpRequestedError text contains the canonical bunx command", () => {
    let err: unknown;
    try {
      parseArgs(["--help"]);
    } catch (e) {
      err = e;
    }
    expect((err as HelpRequestedError).text).toContain("bunx usage-fyi");
  });
});

describe("parseArgs — pr-stats subcommand", () => {
  it("parses pr-stats as the command", () => {
    const args = parseArgs(["pr-stats"]);
    expect(args.command).toBe("pr-stats");
  });

  it("parses --json for pr-stats", () => {
    const args = parseArgs(["pr-stats", "--json"]);
    expect(args.command).toBe("pr-stats");
    expect(args.json).toBe(true);
  });

  it("rejects unknown flags after pr-stats", () => {
    expect(() => parseArgs(["pr-stats", "--preview"])).toThrow(/Unknown flag/);
  });

  it("rejects unknown subcommands", () => {
    expect(() => parseArgs(["unknown-cmd"])).toThrow(/Unknown command/);
  });

  it("pr-stats --help shows pr-stats help text", () => {
    let err: unknown;
    try {
      parseArgs(["pr-stats", "--help"]);
    } catch (e) {
      err = e;
    }
    expect((err as HelpRequestedError).text).toContain("pr-stats");
  });
});

describe("CLI_VERSION", () => {
  it("matches the version in package.json", async () => {
    const pkg = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    let reported: string | null = null;
    try {
      parseArgs(["--version"]);
    } catch (err) {
      if (err instanceof VersionRequestedError) reported = err.version;
      else throw err;
    }
    expect(reported).toBe(pkg.version);
  });
});

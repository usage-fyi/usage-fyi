import { DEFAULT_SOURCE } from "./adapters/registry.js";

export type Command = "publish" | "pr-stats";

export interface ParsedArgs {
  command: Command;
  source: string;
  json: boolean;
  open: boolean;
  preview: boolean;
}

export class LaterPhaseError extends Error {
  readonly flag: string;
  constructor(flag: string) {
    super(`${flag} is coming in a later phase`);
    this.name = "LaterPhaseError";
    this.flag = flag;
  }
}

export class HelpRequestedError extends Error {
  readonly text: string;
  constructor(text: string) {
    super("help requested");
    this.name = "HelpRequestedError";
    this.text = text;
  }
}

export class VersionRequestedError extends Error {
  readonly version: string;
  constructor(version: string) {
    super("version requested");
    this.name = "VersionRequestedError";
    this.version = version;
  }
}

const CLI_VERSION = "0.1.2";

export const HELP_TEXT = `\
usage-fyi — publish your AI coding-agent usage as a shareable card
              (works with Claude Code, Codex, Gemini CLI, and more via ccusage)

  bunx usage-fyi

Options:
  --source <id>      Usage source adapter (default: ${DEFAULT_SOURCE})
  --json             Machine-readable output
  --no-open          Do not open the link in a browser
  --preview          Render the card locally and serve it on a localhost port; share is one click
  --version          Print version and exit
  --help             Print this help

Commands:
  pr-stats           Show per-project PR creation stats from local session files
`;

export const PR_STATS_HELP_TEXT = `\
usage-fyi pr-stats — per-project PR creation stats from local session files

  bunx usage-fyi pr-stats

Options:
  --json             Output raw JSON report
  --help             Print this help
`;

function nextValue(argv: string[], i: number, flag: string): string {
  const val = argv[i + 1];
  if (val === undefined || val.startsWith("-")) {
    throw new Error(`--${flag} requires a value`);
  }
  return val;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "publish",
    source: DEFAULT_SOURCE,
    json: false,
    open: true,
    preview: false,
  };

  let i = 0;

  // Detect subcommand before flag parsing
  if (i < argv.length && !argv[i]!.startsWith("-")) {
    const cmd = argv[i]!;
    if (cmd === "pr-stats") {
      args.command = "pr-stats";
      i++;
    } else {
      throw new Error(`Unknown command: ${cmd}`);
    }
  }

  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h": {
        const text =
          args.command === "pr-stats" ? PR_STATS_HELP_TEXT : HELP_TEXT;
        throw new HelpRequestedError(text);
      }
      case "--version":
        throw new VersionRequestedError(CLI_VERSION);
      case "--json":
        args.json = true;
        break;
      case "--no-open":
        if (args.command === "pr-stats") throw new Error("Unknown flag: --no-open");
        args.open = false;
        break;
      case "--preview":
        if (args.command === "pr-stats") throw new Error("Unknown flag: --preview");
        args.preview = true;
        break;
      case "--source": {
        if (args.command === "pr-stats") throw new Error("Unknown flag: --source");
        args.source = nextValue(argv, i, "source");
        i++;
        break;
      }
      case "--profile":
      case "--token":
        throw new LaterPhaseError(arg);
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
    i++;
  }

  return args;
}

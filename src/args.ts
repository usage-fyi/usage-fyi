import { DEFAULT_SOURCE } from "./adapters/registry.js";

export interface ParsedArgs {
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

const CLI_VERSION = "0.0.1";

export const HELP_TEXT = `\
usage-fyi — publish your AI coding-agent usage as a shareable card
              (works with Claude Code, Codex, Gemini CLI, and more via ccusage)

  bunx @usage-fyi/cli

Options:
  --source <id>      Usage source adapter (default: ${DEFAULT_SOURCE})
  --json             Machine-readable output
  --no-open          Do not open the link in a browser
  --preview          Render the card locally and serve it on a localhost port; share is one click
  --version          Print version and exit
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
    source: DEFAULT_SOURCE,
    json: false,
    open: true,
    preview: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help":
      case "-h":
        throw new HelpRequestedError(HELP_TEXT);
      case "--version":
        throw new VersionRequestedError(CLI_VERSION);
      case "--json":
        args.json = true;
        break;
      case "--no-open":
        args.open = false;
        break;
      case "--preview":
        args.preview = true;
        break;
      case "--source": {
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

# usage-fyi CLI

Publish Claude Code usage snapshots to [usage.fyi](https://usage.fyi) or any compatible self-hosted server.

The CLI collects local Claude usage through `ccusage`, publishes a snapshot, and prints an unlisted share link plus a manage key.

## Installation

```sh
bun install
```

Requirements:

- [Bun](https://bun.sh), including `bunx`
- [ccusage](https://www.npmjs.com/package/ccusage) available through `bunx` or on `PATH`

Check `ccusage`:

```sh
bunx ccusage@latest --version
```

## Usage

```sh
# Publish and open in browser (default)
bun run src/index.ts

# Preview locally before publishing
bun run src/index.ts --preview

# Publish without opening a browser, emit JSON for piping
bun run src/index.ts --no-open --json
```

## Self-Hosting

Set `USAGE_FYI_API_BASE` to publish to a compatible server:

```sh
USAGE_FYI_API_BASE=https://usage.example.com bun run src/index.ts
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--source <id>` | `ccusage` | Usage-source adapter |
| `--preview` | off | Render the card locally on a localhost port instead of publishing; share is one click |
| `--json` | off | Machine-readable output (`{id, url, manageKey, viewerUrl}`) |
| `--no-open` | open | Do not open the published link in a browser |
| `--version` | - | Print version and exit |
| `--help` | - | Print help |

The hosted server is at [usage.fyi](https://usage.fyi). This CLI is open-source under the MIT license.

## Development

```sh
bun install            # install dev dependencies
bun test               # run the test suite
bun run typecheck      # tsc --noEmit
bun run lint           # oxlint
bun run verify         # typecheck + lint + test
```

The CLI vendors a small zero-dependency `core` module under [`src/core/`](src/core).
It encodes the snapshot/style schema, canonical-JSON hashing, and slimming
of `ccusage` output. It is intentionally kept in-tree to keep this repo
free of workspace dependencies.

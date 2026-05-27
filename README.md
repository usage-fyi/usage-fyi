# usage-fyi CLI

Publish your AI coding-agent usage as a shareable snapshot on [usage.fyi](https://usage.fyi) or any compatible self-hosted server.

`usage-fyi` works with the popular agent harnesses — **Claude Code, Codex, Gemini CLI**, and others supported by [`ccusage`](https://www.npmjs.com/package/ccusage). The CLI reads your local usage through `ccusage`, publishes a snapshot, and prints an unlisted share link plus a manage key.

## Installation

Just run it — your package manager fetches the CLI and `ccusage` together, no separate install step:

```sh
npx @usage-fyi/cli       # Node ≥ 20
# or
bunx @usage-fyi/cli      # Bun
```

The CLI is Node-native and runs identically under both runtimes.

## Usage

```sh
# Publish and open in browser (default)
npx @usage-fyi/cli

# Preview locally before publishing
npx @usage-fyi/cli --preview

# Publish without opening a browser, emit JSON for piping
npx @usage-fyi/cli --no-open --json
```

## Self-Hosting

Set `USAGE_FYI_API_BASE` to publish to a compatible server:

```sh
USAGE_FYI_API_BASE=https://usage.example.com npx @usage-fyi/cli
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
npm install            # install dev dependencies
npm test               # run the test suite (vitest)
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint
npm run verify         # typecheck + lint + test
npm run build          # tsc -> dist/
npm start              # run src/index.ts via tsx
```

Bun is also fully supported — `bun src/index.ts` and `bunx vitest run` work without modification, since the source is Node-native.

The CLI vendors a small zero-dependency `core` module under [`src/core/`](src/core).
It encodes the snapshot/style schema, canonical-JSON hashing, and slimming
of `ccusage` output. It is intentionally kept in-tree to keep this repo
free of workspace dependencies.

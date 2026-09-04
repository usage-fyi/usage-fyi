# usage-fyi

> Turn your AI coding-agent usage into beautiful visualisations — preview locally, share only if you want to.

[![CI](https://github.com/usage-fyi/usage-fyi/actions/workflows/ci.yml/badge.svg)](https://github.com/usage-fyi/usage-fyi/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/usage-fyi.svg)](https://www.npmjs.com/package/usage-fyi)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

**`usage-fyi`** reads your local AI agent usage data and turns it into rich, shareable visual cards. Built on top of [`ccusage`](https://www.npmjs.com/package/ccusage), it works out of the box with the most popular agent harnesses:

- **Claude Code**
- **Codex (OpenAI)**
- **Gemini CLI**
- …and any other harness supported by `ccusage`

Everything stays local by default. Sharing is entirely opt-in.

---

## ✨ Features

- **Local-first visualisation** — see your usage as beautiful charts without sending anything anywhere
- **Beautiful cards** — multiple designs, themes, and layouts (wide, portrait, dark, light, and more)
- **Optional sharing** — publish a snapshot only when you choose to; unlisted by default
- **JSON output** — pipe-friendly machine-readable output for custom workflows
- **Zero-config setup** — detects your usage automatically via `ccusage`
- **Deterministic hashing** — canonical JSON ensures identical usage produces identical hashes

---

## 📦 Installation

No global install needed. Your package manager fetches both the CLI and `ccusage` in one shot:

```sh
# Node ≥ 20
npx usage-fyi

# Bun
bunx usage-fyi
```

The CLI is Node-native and runs identically under both runtimes.

---

## 🚀 Quick Start

```sh
# Preview your usage locally (default — nothing leaves your machine)
npx usage-fyi --preview

# Generate a shareable card and open it in your browser
npx usage-fyi

# Publish and print the result as JSON, without opening a browser
npx usage-fyi --no-open --json

# Per-PR and per-session token attribution, entirely local
npx usage-fyi pr-stats --since 2026-08-01
```

---

## 📋 CLI Reference

| Flag | Default | Description |
|------|---------|-------------|
| `--source <id>` | `ccusage` | Usage-source adapter |
| `--preview` | off | Render the card locally on a localhost port instead of publishing |
| `--json` | off | Machine-readable output (`{id, url, manageKey, viewerUrl}`) |
| `--no-open` | open | Do not open the published link in a browser |
| `--version` | — | Print version and exit |
| `--help` | — | Print help |

`--json` still publishes; it only changes how the result is printed. Use
`--preview` when you want nothing to leave your machine.

### `pr-stats`

Correlates pull requests created during agent sessions with the tokens spent
getting there. Reads local session logs only, never publishes.

| Flag | Description |
|------|-------------|
| `--json` | Emit the full `pr-stats/3` report instead of a table |
| `--by <event\|session>` | Group the table by PR event or by session |
| `--since <date>` | Only PRs created on or after this date |
| `--project <path>` | Restrict to one project root |
| `--pr <url\|#n\|n>` | Restrict to a single pull request |

---

## 🎯 Accuracy

Numbers come from [`ccusage`](https://www.npmjs.com/package/ccusage), which is
pinned to an exact version so a given set of logs always produces the same
report.

- **Attribution is exact, not inferred.** Agent and model splits are read
  straight from `ccusage daily --json --by-agent`. Earlier releases probed each
  agent separately and split shared models evenly when two harnesses used the
  same model on the same day; that guesswork is gone.
- **Costs are charged per token type.** Input, output, cache-creation and
  cache-read tokens have very different prices, so `pr-stats` recovers each
  model's four rates from your own `ccusage` history and prices every window
  against its real token mix. A cache-heavy window is no longer billed as if
  it were output.
- **Estimates say how they were made.** Every cost carries a `pricingFlag`:
  `modeled-rate` (per-token-type rates), `blended-rate` (a single averaged
  $/token rate, used when a model has too little history to fit), or
  `unknown-model` (no rate at all, cost reported as `null` rather than
  guessed).
- **`ccusage` warnings are surfaced**, so a model it cannot price shows up on
  stderr instead of silently contributing $0.

Costs are estimates of API-equivalent spend. They are not a bill, and they
cover only the machine you run them on.

---

## 🧩 Architecture

The CLI vendors a small, zero-dependency `core` module under [`src/core/`](src/core). It encodes the snapshot and style schema, canonical-JSON hashing, and slimming of `ccusage` output. It is intentionally kept in-tree to keep this repo free of workspace dependencies.

```
src/
├── index.ts          # CLI entry point and orchestration
├── args.ts           # Argument parsing
├── config.ts         # XDG-aware config loading
├── publish.ts        # HTTP publishing logic
├── preview.ts        # Local dev-server for --preview
├── open.ts           # Cross-platform browser opener
├── style.ts          # Style resolution
├── errors.ts         # Exit codes and error formatting
├── core/             # Zero-dep snapshot schema, hashing, validation
├── adapters/         # Usage-source adapters (ccusage, extensible)
├── analyzers/        # pr-stats: session scanners, windowing, aggregation
└── commands/         # Subcommand entry points
```

---

## 🧪 Development

```sh
# Install dependencies
npm install

# Run the test suite (Vitest)
npm test

# Type check
npm run typecheck

# Lint (oxlint)
npm run lint

# Full verification pipeline
npm run verify        # typecheck + lint + test

# Build for release
npm run build         # tsc -> dist/

# Run locally
npm start             # tsx src/index.ts
```

Bun is also fully supported — `bun src/index.ts` and `bunx vitest run` work without modification, since the source is Node-native.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to open an issue or submit a pull request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Make your changes
4. Ensure the verify pipeline passes (`npm run verify`)
5. Commit your changes (`git commit -m 'feat: add amazing feature'`)
6. Push to the branch (`git push origin feat/amazing-feature`)
7. Open a Pull Request

Please make sure your code follows the existing style and that all tests pass.

---

## 📄 License

MIT © [usage-fyi contributors](https://github.com/usage-fyi)

The hosted server is at [usage.fyi](https://usage.fyi). This CLI is open-source under the MIT license.

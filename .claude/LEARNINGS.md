# Learnings

Non-obvious facts about this repo and its dependencies that a future agent
would otherwise have to rediscover.

---

## ccusage (as of 20.0.20, 2026-08)

### It is a native binary now, not a JavaScript library

- Since **v20.0.0** the npm `ccusage` package is a ~5 KB Node shim that spawns
  a platform-specific native binary from `optionalDependencies`
  (`@ccusage/ccusage-<platform>-<arch>`). The `bin` path moved from
  `dist/cli.js` to `src/cli.js`.
- Because of this, `resolveCcusageBin()` in `src/adapters/ccusage.ts` must keep
  resolving the bin path **through the package manifest**, never by hardcoding
  a path. That is the only reason the 20.0.5 → 20.0.20 upgrade needed no
  adapter change.
- **There is no library API.** `exports` was removed in v19.0.0 (issue #993),
  along with the MCP package. `ccusage/calculate-cost` and
  `ccusage/pricing-fetcher` last existed in the v18.x / v16.x lines and are
  stale. Shelling out to the CLI with `--json` is the only supported surface.
  Do not go looking for a programmatic pricing function; there isn't one.

### `--by-agent` replaces all attribution guesswork

`ccusage daily --json --by-agent` (v20.0.15/16, issue #1396) adds an
`agents: [...]` array to each daily row, each element carrying its own
`modelBreakdowns[]`. This is exact per-(day, agent, model) attribution.

Before this existed the adapter ran `ccusage <agent> daily --json` once per
detected agent and split ambiguous (date, model) pairs evenly. That is now a
fallback path only. The single call is also ~3x faster than 1 + N calls.

### `--breakdown` is a JSON no-op

Since v20.0.15/16, `modelBreakdowns` is emitted unconditionally. Passing
`--breakdown` changes only terminal table rendering. It does **not** add
per-model data to `blocks --json`, which has no model breakdown at all and
uses a different nested schema (`tokenCounts.cacheCreationInputTokens`,
`costUSD`).

### Unified vs per-agent commands have different schemas

- Unified (`ccusage daily`) keys rows by **`period`**; per-agent
  (`ccusage claude daily`) keys them by **`date`**.
- `--project`, `--instances`, `--mode` and `--debug` exist **only** on the
  per-agent Claude commands, not on the unified ones.
- `ccusage codex session --json` uses yet another shape: `models` as an object
  map, plus `costUSD` and `reasoningOutputTokens`.

### Gemini's thinking tokens do not reconcile

On days with Gemini usage, the row's `totalTokens` **exceeds** the sum of
`inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens`, because
Gemini thought tokens are counted in the total but have no field of their own
in `modelBreakdowns`. Measured at ~0.0004% of a 24.7B-token history. Our
`slim()` recomputes day totals from `mb[]`, so those tokens are dropped —
required by the `snapshot/2` invariant that `sum(mb) === day`. Do not "fix"
this by trusting `totalTokens`; it would break the server-side validator.

### Version bumps move the numbers

Upgrading 20.0.5 → 20.0.20 changed the same 117-day history by **+$1,128 (7%)
and +34.5M tokens**. Causes: cache-creation priced by ephemeral duration
(20.0.8), Claude advisor iterations counted (20.0.17), Codex replay dedup
(20.0.19), corrected Opus/Fable rates, and models that previously priced at
$0. **Pin the exact version** — a floating range makes reports irreproducible.

### Unpriced models silently cost $0

A model missing from the pricing catalog contributes tokens but no dollars,
and only says so via a `WARN Missing pricing for <model>` line on **stderr**.
`extractWarnings()` in the adapter forwards those. Note that genuinely local
models (`[pi] qwen/...`) legitimately cost $0, so $0 alone is not a defect.

---

## Recovering per-token-type prices from ccusage output

`ccusage` reports, per (day, model), the four token counts and the exact cost.
That is a linear system in the four unknown rates, so the rates a model was
actually billed at can be recovered by least squares.

Two things matter:

1. **Non-negativity is required.** Input and cache-read token counts are
   strongly correlated in real usage, so an unconstrained fit routinely
   returns a *negative* input rate. With only four unknowns, exact NNLS is
   cheap: enumerate all 16 active sets, solve each unconstrained, keep the
   feasible ones, take the lowest SSE. No iteration tolerance needed.
2. **Identifiability needs a varying token mix.** If every observation has the
   same i:o:cc:cr ratio the columns are collinear and many rate vectors fit
   equally well. Real day-to-day usage varies enough; synthetic test data must
   be generated with a varying mix or the fit lands on a valid-but-different
   solution. This is why `pricedRows()` in `test/ccusage.test.ts` uses a seeded
   PRNG rather than a linear ramp.

Measured on a real 117-day history: mean absolute error against ccusage's own
per-(day, model) costs is **2.6% out of sample**, versus **9.9%** for a single
blended $/token rate. For models with clean history the fit recovers published
list prices exactly (Sonnet 5 came back as $2 / $10 / $2.50 / $0.20 per Mtok).

Guardrails that matter: require >= 8 observations before trusting a fit, and
reject any rate above a sanity ceiling. A single-observation model fits four
unknowns with one equation and produced a nonsense $16,976/Mtok input rate.

Note that Anthropic's tiered pricing kicks in **above 200k context**, not 1M,
so a single linear rate vector is an average over both tiers rather than an
exact price. That is acceptable here and is why the fit is not expected to hit
0% error on Claude models.

---

## Repo conventions

- `npm run verify` = typecheck + lint + test across both workspaces. Run it
  before claiming anything is done.
- The published wire format lives in `@usage-fyi/wire` and is shared with the
  usage.fyi server. `snapshot/2` enforces five invariants server-side (mb sums
  equal day totals, cost is the rounded sum, `m`/`a` are derived from `mb`,
  `mb` sorted by (a, m)). Changing it is a coordinated server change — prefer
  improving the numbers inside the existing shape.
- `--json` **publishes**; `--preview` is the local-only flag. The README used
  to claim otherwise.
- `CLI_VERSION` in `src/args.ts` is hand-maintained and drifted from
  package.json once already. `test/args.test.ts` now fails the build if they
  disagree.
- Releases are cut by pushing a `cli-v*` or `wire-v*` tag; GitHub Actions
  publishes to npm with provenance. Nothing publishes from a local machine.

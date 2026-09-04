# Changelog

All notable changes to this project are documented here. The CLI is published
as [`usage-fyi`](https://www.npmjs.com/package/usage-fyi); the shared contract
package is [`@usage-fyi/wire`](https://www.npmjs.com/package/@usage-fyi/wire).

## 0.2.0

Accuracy release. Every number the tool reports is either exact where it used
to be inferred, or materially closer where it used to be approximated.

### Changed — `ccusage` 20.0.5 → 20.0.20

`ccusage` fixed several counting and pricing bugs in this range. On a
24.7-billion-token, 117-day history the same logs now report **$1,128 (7%)
more spend and 34.5M more tokens**, driven by upstream fixes for:

- cache-creation pricing split by ephemeral duration (5-minute vs 1-hour)
- Claude Code advisor iterations, previously not counted at all
- Codex replay and archived-session deduplication
- corrected rates for the Opus and Fable model families
- pricing for models that previously resolved to $0

`ccusage` also became a native binary distributed through platform-specific
optional dependencies, and removed its library API entirely. The adapter
already resolved the binary through the package manifest, so it needed no
change, but the CLI is now the only supported integration surface.

### Changed — agent attribution is exact

Snapshots are built from `ccusage daily --json --by-agent`, which reports the
real per-(day, agent, model) split.

- Removed the heuristics this replaces: per-agent subprocess probing, even
  splitting of a model claimed by two harnesses on the same day, and
  model-name prefix inference.
- Collection now makes **one** subprocess call instead of one per detected
  agent — about **3x faster** (8.0s → 2.7s on a 117-day history).
- Verified against `ccusage` on real data: all 392 (day, agent, model) rows
  match exactly, with zero token differences.

The previous heuristic path is retained as a fallback for a `ccusage` that
does not support `--by-agent`.

### Changed — `pr-stats` costs are charged per token type

Cost estimation no longer multiplies a window's total token count by a single
blended $/token rate. Input, output, cache-creation and cache-read tokens
differ in price by up to 100x, so that rate was only correct for a window
whose token mix happened to match the daily average.

Each model's four per-token-type rates are now recovered from its own
`ccusage` history by exact non-negative least squares, and every window is
priced against its real mix. Measured against `ccusage`'s own per-(day, model)
costs, mean absolute error drops from **9.9% to 2.6%** out of sample. For
models with clean history the fit recovers published list prices exactly.

Models with fewer than 8 observations, or whose fit is degenerate, keep the
old blended rate rather than risk a wild extrapolation.

### Added

- `pricingFlag` on individual PR events, so a per-PR cost carries the same
  provenance the session and project totals already did.
- A `modeled-rate` value for `pricingFlag`, distinguishing per-token-type
  estimates from coarse `blended-rate` ones.
- `ccusage` warnings (for example a model it cannot price, which otherwise
  contributes tokens but $0) are forwarded to stderr instead of discarded.

### Changed — `pr-stats` report schema `pr-stats/2` → `pr-stats/3`

Cost values change meaningfully, so the schema version changes with them.
The shape is otherwise additive; consumers reading only the existing keys
keep working.

### Fixed

- `pr-stats` no longer spawns a `ccusage` subprocess when there are no
  sessions to price.
- README no longer claims `--json` makes no network call. It publishes, like
  the default invocation; `--preview` is the flag that keeps everything local.

### Unchanged

- The published wire format is still `snapshot/2`. Snapshots from this release
  validate against the same server contract; only the numbers inside them are
  more accurate.

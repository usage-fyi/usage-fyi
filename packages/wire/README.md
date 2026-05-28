# @usage-fyi/wire

Shared wire contract between the [`usage-fyi`](https://www.npmjs.com/package/usage-fyi) CLI (the producer) and the usage.fyi server (the consumer). This package exists so the byte-identical canonicalisation and content-hash bits stop being vendored in two places — drift in those bytes silently breaks internal blob dedupe and idempotency-key matching.

If you're not building a producer of usage.fyi snapshots, you almost certainly don't need this package.

## What's in here

- `canonicalize(value)` — stable, deterministic JSON serializer. Recursively sorts object keys; preserves array order; identical value ⇒ identical string.
- `contentHash(snapshot)` / `hashBytes(bytes)` — SHA-256 over the canonical bytes, returned as a base64url string. Uses Web Crypto, so the package runs unchanged in Node, Bun, browsers, and Cloudflare Workers.
- The wire-shape types: `Snapshot`, `DailyEntry`, `ModelBreakdown`, `Style`, plus the const enum arrays and supporting interfaces (`Derived`, `Totals`, `WindowAgg`, `Origin`, `Design`, `Theme`, `Format`).

The schema literals on those interfaces (`"snapshot/2"`, `"style/1"`) are part of the contract. Bumping a schema integer or changing canonicalisation is a breaking change to this package — major-version bump.

## What's NOT in here

Validators, slimmers, disclosure copy, and any other producer-only or consumer-only logic. Each side keeps its own; only the byte-identical layer lives here.

## License

MIT.

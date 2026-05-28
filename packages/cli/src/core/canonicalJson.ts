// Re-export from the shared wire contract. The original implementation has
// moved to @usage-fyi/wire ([docs/27]); this file is kept as a re-export so
// local imports of `./canonicalJson.js` continue to resolve. Step 5 deletes
// this file outright and the barrel index.ts re-exports from wire directly.
export { canonicalize } from "@usage-fyi/wire";

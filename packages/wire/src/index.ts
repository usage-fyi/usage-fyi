// @usage-fyi/wire — the byte-identical contract between the usage-fyi CLI
// (producer) and the usage.fyi server (consumer). Zero runtime dependencies;
// runs unchanged in Bun, Node, browsers, and Cloudflare Workers.
//
// See docs/27-shared-wire-contract.md in usage-fyi-internal for the design.
export * from "./canonicalize.js";
export * from "./hash.js";
export * from "./schema.js";

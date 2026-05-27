import { canonicalize } from "./canonicalJson.js";
import type { Snapshot } from "./types.js";

/** SHA-256 of arbitrary bytes. Returns a base64url string. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buf);
  return base64url(new Uint8Array(hashBuffer));
}

/**
 * SHA-256 of the canonical JSON representation of a snapshot.
 * Returns a base64url string.
 *
 * IMPORTANT: this is internal blob dedupe only — NOT the public /s/:id key.
 * Public links are separate immutable share artifacts minted per publish ([docs/04] Link, [docs/06]).
 *
 * Uses Web Crypto (crypto.subtle) — isomorphic across Bun and browser, zero runtime deps.
 * Returns a Promise because SubtleCrypto.digest is always async.
 */
export async function contentHash(snapshot: Snapshot): Promise<string> {
  const json = canonicalize(snapshot);
  return hashBytes(new TextEncoder().encode(json));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

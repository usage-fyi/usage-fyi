/**
 * Stable, deterministic JSON serializer: recursively sort object keys,
 * preserve array order. Identical value ⇒ identical string.
 * Used by contentHash for internal blob dedupe.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k]));
  return '{' + parts.join(',') + '}';
}

import type { Snapshot, Style, Design, Theme, Format } from './types.js';
import { DESIGNS, THEMES, FORMATS, DEFAULT_STYLE } from './types.js';

// ─── validateSnapshot ──────────────────────────────────────────────────────

type ValidateResult =
  | { ok: true; value: Snapshot }
  | { ok: false; errors: string[] };

/**
 * Validate that input is a snapshot/1.
 * Unknown extra fields are preserved on the object, never stripped, never thrown on.
 * This is the forward-compat contract: renderers must handle every published
 * schema version forever ([docs/04] Versioning rules).
 */
export function validateSnapshot(input: unknown): ValidateResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['expected object'] };
  }

  const obj = input as Record<string, unknown>;

  if (obj['schema'] !== 'snapshot/1') {
    errors.push(`expected schema "snapshot/1", got ${JSON.stringify(obj['schema'])}`);
  }
  if (typeof obj['generatedAt'] !== 'string') {
    errors.push('generatedAt must be a string');
  }
  if (obj['origin'] !== 'self-reported' && obj['origin'] !== 'tool-collected') {
    errors.push(`origin must be "self-reported" or "tool-collected", got ${JSON.stringify(obj['origin'])}`);
  }
  if (typeof obj['source'] !== 'object' || obj['source'] === null) {
    errors.push('source must be an object');
  }
  if (!Array.isArray(obj['daily'])) {
    errors.push('daily must be an array');
  }
  if (typeof obj['totals'] !== 'object' || obj['totals'] === null) {
    errors.push('totals must be an object');
  }
  if (typeof obj['derived'] !== 'object' || obj['derived'] === null) {
    errors.push('derived must be an object');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Cast preserving any unknown fields — never strip them.
  return { ok: true, value: input as Snapshot };
}

// ─── validateStyle ─────────────────────────────────────────────────────────

/**
 * Coerce input to a Style, falling back to DEFAULT_STYLE defaults for unknown
 * enum values. Never throws — unknown values are a forward-compat signal, not
 * an error ([docs/04] Versioning rules).
 */
export function validateStyle(input: unknown): Style {
  const obj = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)
    : {};

  const design = (DESIGNS as readonly string[]).includes(obj['design'] as string)
    ? (obj['design'] as Design)
    : DEFAULT_STYLE.design;

  const theme = (THEMES as readonly string[]).includes(obj['theme'] as string)
    ? (obj['theme'] as Theme)
    : DEFAULT_STYLE.theme;

  const format = (FORMATS as readonly string[]).includes(obj['format'] as string)
    ? (obj['format'] as Format)
    : DEFAULT_STYLE.format;

  return { schema: 'style/1', design, theme, format };
}

// ─── shimSnapshot ──────────────────────────────────────────────────────────

/**
 * Forward-compat shim: normalises any published snapshot version to the
 * current in-memory Snapshot shape.
 *
 * Renderers must handle every published schema version forever (immutability
 * implies render-compatibility forever — [docs/04] Versioning rules).
 * Add a case here for each new version as it is published.
 *
 * TODO: when snapshot/2 ships, add a migration branch before this default.
 */
export function shimSnapshot(input: unknown): Snapshot {
  if (typeof input !== 'object' || input === null) {
    throw new UnsupportedSchemaError(String(input));
  }
  const schema = (input as Record<string, unknown>)['schema'];
  switch (schema) {
    case 'snapshot/1':
      return input as Snapshot;
    default:
      throw new UnsupportedSchemaError(String(schema));
  }
}

export class UnsupportedSchemaError extends Error {
  constructor(public readonly schema: string) {
    super(`Unsupported schema version: ${schema}`);
    this.name = 'UnsupportedSchemaError';
  }
}

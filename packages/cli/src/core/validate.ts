import type { Snapshot, Style, Design, Theme, Format } from "./types.js";
import { DESIGNS, THEMES, FORMATS, DEFAULT_STYLE } from "./types.js";

// ─── validateSnapshot ──────────────────────────────────────────────────────

type ValidateResult =
  | { ok: true; value: Snapshot }
  | { ok: false; errors: string[] };

/**
 * Validate that input is a snapshot/2 — the only schema the CLI emits.
 * Unknown extra fields are preserved on the object, never stripped, never thrown on.
 * This is the forward-compat contract: renderers must handle every published
 * schema version forever ([docs/04] Versioning rules).
 */
export function validateSnapshot(input: unknown): ValidateResult {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["expected object"] };
  }

  const obj = input as Record<string, unknown>;

  if (obj["schema"] !== "snapshot/2") {
    errors.push(
      `expected schema "snapshot/2", got ${JSON.stringify(obj["schema"])}`,
    );
  }
  if (typeof obj["generatedAt"] !== "string") {
    errors.push("generatedAt must be a string");
  }
  if (obj["origin"] !== "self-reported" && obj["origin"] !== "tool-collected") {
    errors.push(
      `origin must be "self-reported" or "tool-collected", got ${JSON.stringify(obj["origin"])}`,
    );
  }
  if (typeof obj["source"] !== "object" || obj["source"] === null) {
    errors.push("source must be an object");
  }
  if (!Array.isArray(obj["daily"])) {
    errors.push("daily must be an array");
  }
  if (typeof obj["totals"] !== "object" || obj["totals"] === null) {
    errors.push("totals must be an object");
  }
  if (typeof obj["derived"] !== "object" || obj["derived"] === null) {
    errors.push("derived must be an object");
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
  const obj =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const design = (DESIGNS as readonly string[]).includes(
    obj["design"] as string,
  )
    ? (obj["design"] as Design)
    : DEFAULT_STYLE.design;

  const theme = (THEMES as readonly string[]).includes(obj["theme"] as string)
    ? (obj["theme"] as Theme)
    : DEFAULT_STYLE.theme;

  const format = (FORMATS as readonly string[]).includes(
    obj["format"] as string,
  )
    ? (obj["format"] as Format)
    : DEFAULT_STYLE.format;

  return { schema: "style/1", design, theme, format };
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
 * snapshot/1 (legacy) → upgraded in-memory to snapshot/2 by inferring per-day
 * mb[] from the day-level totals (best-effort; ambiguity is unavoidable here,
 * which is exactly why snapshot/2 exists). The reverse — taking the unsound
 * inference and embedding it as new mb data in a published snapshot — is
 * deliberately not done; the shim is read-side only.
 */
export function shimSnapshot(input: unknown): Snapshot {
  if (typeof input !== "object" || input === null) {
    throw new UnsupportedSchemaError(String(input));
  }
  const schema = (input as Record<string, unknown>)["schema"];
  switch (schema) {
    case "snapshot/2":
      return input as Snapshot;
    case "snapshot/1":
      return upgradeV1ToV2(input as Record<string, unknown>);
    default:
      throw new UnsupportedSchemaError(String(schema));
  }
}

/**
 * Best-effort read-side shim from snapshot/1 to the in-memory snapshot/2
 * shape. We can't recover real per-(agent, model) attribution after the fact
 * — that information was never collected — so each day gets a single
 * synthetic mb entry per model carrying day-level totals split evenly across
 * models, attributed to the first listed agent (or "other"). This is purely
 * to keep renderers running against older published snapshots.
 */
function upgradeV1ToV2(v1: Record<string, unknown>): Snapshot {
  const out = { ...v1, schema: "snapshot/2" } as Record<string, unknown>;
  const daily = Array.isArray(v1["daily"]) ? v1["daily"] : [];
  out["daily"] = daily.map((d) => {
    const day = d as Record<string, unknown>;
    if (Array.isArray(day["mb"])) return day; // already has mb (shouldn't happen for v1)
    const models = Array.isArray(day["m"]) ? (day["m"] as string[]) : [];
    const agents = Array.isArray(day["a"]) ? (day["a"] as string[]) : [];
    const agent = agents[0] ?? "other";
    const i = Number(day["i"] ?? 0);
    const o = Number(day["o"] ?? 0);
    const cc = Number(day["cc"] ?? 0);
    const cr = Number(day["cr"] ?? 0);
    const t = Number(day["t"] ?? 0);
    const c = Number(day["c"] ?? 0);
    const n = Math.max(models.length, 1);
    const mb = (models.length > 0 ? models : ["unknown"]).map((m, k) => ({
      a: agent,
      m,
      i: k === 0 ? i - Math.floor(i / n) * (n - 1) : Math.floor(i / n),
      o: k === 0 ? o - Math.floor(o / n) * (n - 1) : Math.floor(o / n),
      cc: k === 0 ? cc - Math.floor(cc / n) * (n - 1) : Math.floor(cc / n),
      cr: k === 0 ? cr - Math.floor(cr / n) * (n - 1) : Math.floor(cr / n),
      t: k === 0 ? t - Math.floor(t / n) * (n - 1) : Math.floor(t / n),
      c:
        k === 0
          ? Math.round(
              (c - (Math.round((c / n) * 100) / 100) * (n - 1)) * 100,
            ) / 100
          : Math.round((c / n) * 100) / 100,
    }));
    return { ...day, mb };
  });
  return out as unknown as Snapshot;
}

export class UnsupportedSchemaError extends Error {
  constructor(public readonly schema: string) {
    super(`Unsupported schema version: ${schema}`);
    this.name = "UnsupportedSchemaError";
  }
}

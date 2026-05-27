import type { Style } from "./core/index.js";

/** Fixed card style — single design, no user-configurable overrides. */
export const CARD_STYLE: Style = {
  schema: "style/1",
  design: "og",
  theme: "dark",
  format: "wide",
};

/** Returns the fixed card style. The style argument is ignored; kept for call-site compatibility. */
export function buildStyle(_settings: { source: string; apiBase: string }): Style {
  return CARD_STYLE;
}

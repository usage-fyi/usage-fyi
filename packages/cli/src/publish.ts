import type { Snapshot, Style } from "./core/index.js";

export interface PublishResult {
  id: string;
  manageKey: string;
}

export class PublishError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Publish failed: HTTP ${status}`);
    this.name = "PublishError";
    this.status = status;
    this.body = body;
  }
}

/**
 * POST exactly { snapshot, style } to ${apiBase}/api/snapshots.
 * Throws PublishError on any non-2xx response.
 */
export async function publishSnapshot(
  snapshot: Snapshot,
  style: Style,
  apiBase: string,
): Promise<PublishResult> {
  const response = await fetch(`${apiBase}/api/snapshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot, style }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PublishError(response.status, body);
  }

  const data = (await response.json()) as { id: string; manageKey: string };
  return { id: data.id, manageKey: data.manageKey };
}

// Producer-only persisted entity types — mirrors docs/04-data-model.md.
//
// Wire-shape types (Snapshot, DailyEntry, ModelBreakdown, Style + supporting
// enums/interfaces) live in @usage-fyi/wire ([docs/27]) and are imported
// directly from there; this file only carries the local-only entities.

import type { Style, Origin } from "@usage-fyi/wire";

// ─── Link ─────────────────────────────────────────────────────────────────────

export interface Link {
  schema: "link/1";
  id: string;
  /** Content hash of the target snapshot — internal dedupe, NOT the public /s/:id key. */
  snapshot: string;
  style: Style;
  /** Declared by the publisher, recorded verbatim, never upgraded server-side ([docs/21]). */
  origin: Origin;
  manageKey: string;
  state: "live" | "tombstoned";
  createdAt: string;
  removedAt?: string;
  visibility: "unlisted";
  owner: null;
}

// ─── User ─────────────────────────────────────────────────────────────────────

/** Deliberately thin — identity only, not profile data. Shape-only in Phase 1. */
export interface User {
  schema: "user/1";
  id: string;
  auth: {
    method: "oauth" | "email-link";
    subject: string;
  };
  createdAt: string;
}

// ─── Profile ──────────────────────────────────────────────────────────────────

/** Shape-only in Phase 1. */
export interface Profile {
  schema: "profile/1";
  username: string;
  owner: string;
  /** Optional public display data, owner-supplied only — never enriched/scraped ([docs/09]). */
  display?: {
    name?: string;
    bio?: string;
    link?: string;
    github?: string;
  };
  current: string;
  history: string[];
  style: Style;
  freshness: {
    updatedAt: string;
    source: "collector" | "manual";
  };
}

// ─── CollectorToken ───────────────────────────────────────────────────────────

/** Shape-only in Phase 1. Scoped to one profile, publish-only. */
export interface CollectorToken {
  schema: "token/1";
  id: string;
  profile: string;
  scope: string[];
  createdAt: string;
  lastUsedAt: string;
  revoked: boolean;
}

// ─── Event ────────────────────────────────────────────────────────────────────

/** Privacy-preserving instrumentation — no PII, no snapshot content ([docs/04], [docs/17]). */
export interface Event {
  schema: "event/1";
  type: string;
  surface: "paste" | "command" | "helper" | "mcp" | "page" | "og";
  phase: number;
  day: string;
  shareRef?: string;
}

// ─── InterestSignal ───────────────────────────────────────────────────────────

/** The only entity that may hold PII — and only by explicit opt-in ([docs/04], [docs/19]). */
export interface InterestSignal {
  schema: "interest/1";
  feature: string;
  contact: { email: string } | { user: string };
  relatedUpdates: boolean;
  consent: {
    copyVersion: string;
    scope: "notify" | "notify+related";
    at: string;
    confirmed: boolean;
  };
  createdAt: string;
  lastEngagedAt: string;
}

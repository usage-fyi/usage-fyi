// Per-project PR-event aggregation with latency percentiles.
//
// Takes PR events and session metadata, computes per-project stats keyed by
// canonical project path. Sessions with no PRs are counted but excluded from
// latency percentiles. Negative ms-to-first-PR is clamped to 0 with a debug
// log.

// ─── Input shapes ───────────────────────────────────────────────────────────

export interface AggregateEvent {
  /** Canonical project path (e.g. "usage-fyi/usage-fyi"). */
  project: string;
  /** Session that created the PR. */
  sessionId: string;
  /** ISO-8601 timestamp of PR creation. */
  createdAt: string;
}

export interface AggregateSessionMeta {
  /** Canonical project path. */
  project: string;
  sessionId: string;
  /** ISO-8601 timestamp of session start. */
  startedAt: string;
}

// ─── Output shapes ──────────────────────────────────────────────────────────

export interface ProjectStats {
  prCount: number;
  sessionCount: number;
  sessionsWithNoPR: number;
  /** Null when no session in this project has any PRs. */
  medianMsToFirstPR: number | null;
  /** Null when no session in this project has any PRs. */
  p90MsToFirstPR: number | null;
}

export interface AggregateResult {
  byProject: Record<string, ProjectStats>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAsc[mid]!;
  return (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}

function p90(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const idx = Math.ceil(0.9 * n) - 1;
  return sortedAsc[Math.max(0, idx)]!;
}

// ─── aggregate() ────────────────────────────────────────────────────────────

/**
 * Aggregate PR events into per-project stats.
 *
 * - `prCount` counts every event whose `project` matches, even if the session
 *   is not present in `sessionMetas`.
 * - `sessionCount` and `sessionsWithNoPR` are driven by `sessionMetas`.
 * - Latency percentiles include only sessions that have at least one PR.
 * - `msToFirstPR` is `earliestPR - sessionStart`. Negative values are clamped
 *   to 0 and a debug message is emitted.
 */
export function aggregate(
  events: AggregateEvent[],
  sessionMetas: AggregateSessionMeta[],
): AggregateResult {
  // Collect every project seen in either input.
  const allProjects = new Set<string>();
  for (const m of sessionMetas) allProjects.add(m.project);
  for (const e of events) allProjects.add(e.project);

  // Group sessions by project.
  const sessionsByProject = new Map<string, AggregateSessionMeta[]>();
  for (const m of sessionMetas) {
    const list = sessionsByProject.get(m.project);
    if (list) list.push(m);
    else sessionsByProject.set(m.project, [m]);
  }

  // Group events by project (for prCount) and by (project, sessionId) (for latency).
  const eventsByProject = new Map<string, AggregateEvent[]>();
  const eventsBySession = new Map<string, AggregateEvent[]>();
  for (const e of events) {
    const projList = eventsByProject.get(e.project);
    if (projList) projList.push(e);
    else eventsByProject.set(e.project, [e]);

    const sessionKey = `${e.project}\x00${e.sessionId}`;
    const sessList = eventsBySession.get(sessionKey);
    if (sessList) sessList.push(e);
    else eventsBySession.set(sessionKey, [e]);
  }

  const byProject: Record<string, ProjectStats> = {};

  for (const project of allProjects) {
    const sessions = sessionsByProject.get(project) ?? [];
    const projectEvents = eventsByProject.get(project) ?? [];

    let sessionsWithNoPR = 0;
    const msToFirstPRs: number[] = [];

    for (const session of sessions) {
      const sessionKey = `${session.project}\x00${session.sessionId}`;
      const sessEvents = eventsBySession.get(sessionKey) ?? [];

      if (sessEvents.length === 0) {
        sessionsWithNoPR++;
        continue;
      }

      let earliest = Infinity;
      for (const ev of sessEvents) {
        const t = toMs(ev.createdAt);
        if (t < earliest) earliest = t;
      }

      const startedAt = toMs(session.startedAt);
      let ms = earliest - startedAt;
      if (ms < 0) {
        // eslint-disable-next-line no-console
        console.debug(
          `Negative msToFirstPR (${ms}ms) for session ${session.sessionId} in project ${project}; clamping to 0.`,
        );
        ms = 0;
      }
      msToFirstPRs.push(ms);
    }

    const sorted = [...msToFirstPRs].sort((a, b) => a - b);

    byProject[project] = {
      prCount: projectEvents.length,
      sessionCount: sessions.length,
      sessionsWithNoPR,
      medianMsToFirstPR: sorted.length === 0 ? null : median(sorted),
      p90MsToFirstPR: sorted.length === 0 ? null : p90(sorted),
    };
  }

  return { byProject };
}

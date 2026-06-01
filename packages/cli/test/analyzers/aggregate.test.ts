/**
 * Unit tests for aggregate() — per-project PR stats with latency percentiles.
 */
import { describe, it, expect, vi } from "vitest";
import {
  aggregate,
  type AggregateEvent,
  type AggregateSessionMeta,
} from "../../src/analyzers/index.js";

function event(
  project: string,
  sessionId: string,
  createdAt: string,
): AggregateEvent {
  return { project, sessionId, createdAt };
}

function session(
  project: string,
  sessionId: string,
  startedAt: string,
): AggregateSessionMeta {
  return { project, sessionId, startedAt };
}

describe("aggregate() — basic shape", () => {
  it("returns empty byProject when both inputs are empty", () => {
    const result = aggregate([], []);
    expect(Object.keys(result.byProject)).toHaveLength(0);
  });

  it("includes a project seen only in sessionMetas", () => {
    const result = aggregate([], [session("org/a", "s1", "2026-06-01T00:00:00Z")]);
    expect(result.byProject["org/a"]).toEqual({
      prCount: 0,
      sessionCount: 1,
      sessionsWithNoPR: 1,
      medianMsToFirstPR: null,
      p90MsToFirstPR: null,
    });
  });

  it("includes a project seen only in events", () => {
    const result = aggregate(
      [event("org/b", "s1", "2026-06-01T01:00:00Z")],
      [],
    );
    expect(result.byProject["org/b"]).toEqual({
      prCount: 1,
      sessionCount: 0,
      sessionsWithNoPR: 0,
      medianMsToFirstPR: null,
      p90MsToFirstPR: null,
    });
  });
});

describe("aggregate() — prCount and sessionCount", () => {
  it("counts total PR events per project", () => {
    const result = aggregate(
      [
        event("p", "s1", "2026-06-01T01:00:00Z"),
        event("p", "s1", "2026-06-01T02:00:00Z"),
        event("p", "s2", "2026-06-01T03:00:00Z"),
      ],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    expect(result.byProject["p"]!.prCount).toBe(3);
    expect(result.byProject["p"]!.sessionCount).toBe(2);
    expect(result.byProject["p"]!.sessionsWithNoPR).toBe(0);
  });

  it("counts PRs for unknown sessions toward prCount", () => {
    const result = aggregate(
      [event("p", "unknown", "2026-06-01T01:00:00Z")],
      [session("p", "s1", "2026-06-01T00:00:00Z")],
    );
    expect(result.byProject["p"]!.prCount).toBe(1);
    expect(result.byProject["p"]!.sessionCount).toBe(1);
    expect(result.byProject["p"]!.sessionsWithNoPR).toBe(1);
  });
});

describe("aggregate() — zero-PR sessions", () => {
  it("counts zero-PR sessions but excludes them from percentiles", () => {
    const result = aggregate(
      [event("p", "s1", "2026-06-01T01:00:00Z")],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    const stats = result.byProject["p"]!;
    expect(stats.sessionCount).toBe(2);
    expect(stats.sessionsWithNoPR).toBe(1);
    expect(stats.medianMsToFirstPR).toBe(60 * 60 * 1000);
    expect(stats.p90MsToFirstPR).toBe(60 * 60 * 1000);
  });

  it("returns null percentiles when every session has zero PRs", () => {
    const result = aggregate(
      [],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    const stats = result.byProject["p"]!;
    expect(stats.sessionsWithNoPR).toBe(2);
    expect(stats.medianMsToFirstPR).toBeNull();
    expect(stats.p90MsToFirstPR).toBeNull();
  });
});

describe("aggregate() — median and p90 math", () => {
  it("computes median for odd-length samples", () => {
    const result = aggregate(
      [
        event("p", "s1", "2026-06-01T01:00:00Z"), // 1h
        event("p", "s2", "2026-06-01T02:00:00Z"), // 2h
        event("p", "s3", "2026-06-01T03:00:00Z"), // 3h
      ],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
        session("p", "s3", "2026-06-01T00:00:00Z"),
      ],
    );
    const stats = result.byProject["p"]!;
    expect(stats.medianMsToFirstPR).toBe(2 * 60 * 60 * 1000);
  });

  it("computes median for even-length samples", () => {
    const result = aggregate(
      [
        event("p", "s1", "2026-06-01T01:00:00Z"), // 1h
        event("p", "s2", "2026-06-01T03:00:00Z"), // 3h
      ],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    const stats = result.byProject["p"]!;
    expect(stats.medianMsToFirstPR).toBe(2 * 60 * 60 * 1000);
  });

  it("computes p90 for small samples (nearest-rank)", () => {
    // 1 element → p90 is the only element
    const r1 = aggregate(
      [event("p", "s1", "2026-06-01T01:00:00Z")],
      [session("p", "s1", "2026-06-01T00:00:00Z")],
    );
    expect(r1.byProject["p"]!.p90MsToFirstPR).toBe(60 * 60 * 1000);

    // 2 elements → ceil(0.9*2)-1 = 1 → second element
    const r2 = aggregate(
      [
        event("p", "s1", "2026-06-01T01:00:00Z"), // 1h
        event("p", "s2", "2026-06-01T02:00:00Z"), // 2h
      ],
      [
        session("p", "s1", "2026-06-01T00:00:00Z"),
        session("p", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    expect(r2.byProject["p"]!.p90MsToFirstPR).toBe(2 * 60 * 60 * 1000);

    // 10 elements → ceil(9)-1 = 8 → 9th element (0-indexed)
    const events: AggregateEvent[] = [];
    const sessions: AggregateSessionMeta[] = [];
    for (let i = 1; i <= 10; i++) {
      events.push(event("p", `s${i}`, `2026-06-01T0${i}:00:00Z`));
      sessions.push(session("p", `s${i}`, "2026-06-01T00:00:00Z"));
    }
    const r10 = aggregate(events, sessions);
    expect(r10.byProject["p"]!.p90MsToFirstPR).toBe(9 * 60 * 60 * 1000);
  });
});

describe("aggregate() — earliest PR per session", () => {
  it("uses the earliest PR when a session has multiple PRs", () => {
    const result = aggregate(
      [
        event("p", "s1", "2026-06-01T02:00:00Z"),
        event("p", "s1", "2026-06-01T01:00:00Z"),
        event("p", "s1", "2026-06-01T03:00:00Z"),
      ],
      [session("p", "s1", "2026-06-01T00:00:00Z")],
    );
    expect(result.byProject["p"]!.medianMsToFirstPR).toBe(60 * 60 * 1000);
  });
});

describe("aggregate() — negative msToFirstPR clamping", () => {
  it("clamps negative msToFirstPR to 0 and logs a debug message", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const result = aggregate(
      [event("p", "s1", "2026-05-31T23:00:00Z")],
      [session("p", "s1", "2026-06-01T00:00:00Z")],
    );

    const stats = result.byProject["p"]!;
    expect(stats.medianMsToFirstPR).toBe(0);
    expect(stats.p90MsToFirstPR).toBe(0);
    expect(debugSpy).toHaveBeenCalledOnce();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Negative msToFirstPR"),
    );

    debugSpy.mockRestore();
  });
});

describe("aggregate() — multiple projects", () => {
  it("partitions stats by canonical project path", () => {
    const result = aggregate(
      [
        event("org/a", "s1", "2026-06-01T01:00:00Z"),
        event("org/b", "s2", "2026-06-01T02:00:00Z"),
      ],
      [
        session("org/a", "s1", "2026-06-01T00:00:00Z"),
        session("org/b", "s2", "2026-06-01T00:00:00Z"),
      ],
    );
    expect(result.byProject["org/a"]!.prCount).toBe(1);
    expect(result.byProject["org/b"]!.prCount).toBe(1);
    expect(result.byProject["org/a"]!.medianMsToFirstPR).toBe(60 * 60 * 1000);
    expect(result.byProject["org/b"]!.medianMsToFirstPR).toBe(2 * 60 * 60 * 1000);
  });
});

import { describe, it, expect } from "vitest";
import type { UsageAdapter } from "../src/adapters/types";
import {
  DEFAULT_SOURCE,
  UnknownSourceError,
  getAdapter,
  registerAdapter,
} from "../src/adapters/registry";

describe("adapter registry", () => {
  it("DEFAULT_SOURCE is 'ccusage'", () => {
    expect(DEFAULT_SOURCE).toBe("ccusage");
  });

  it("getAdapter throws UnknownSourceError for an unregistered id", () => {
    expect(() => getAdapter("__nonexistent_xyz__")).toThrow(UnknownSourceError);
  });

  it("UnknownSourceError carries the source id", () => {
    let caught: unknown;
    try {
      getAdapter("__bad_source__");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownSourceError);
    expect((caught as UnknownSourceError).source).toBe("__bad_source__");
  });

  it("UnknownSourceError message includes the source id", () => {
    let caught: unknown;
    try {
      getAdapter("bad-source-name");
    } catch (err) {
      caught = err;
    }
    expect((caught as UnknownSourceError).message).toContain("bad-source-name");
  });

  it("registerAdapter then getAdapter round-trips", () => {
    const stub: UsageAdapter = {
      id: "__test_adapter__",
      available: async () => true,
      collect: async () => null,
      toSnapshot: () => {
        throw new Error("not implemented");
      },
    };
    registerAdapter(stub);
    expect(getAdapter("__test_adapter__")).toBe(stub);
  });
});

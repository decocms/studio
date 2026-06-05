import { describe, expect, it } from "bun:test";
import {
  parsePullPercent,
  shouldUsePullTransport,
} from "./pull-transport-canary";

describe("parsePullPercent", () => {
  it("returns 0 for missing/invalid", () => {
    expect(parsePullPercent(undefined)).toBe(0);
    expect(parsePullPercent("")).toBe(0);
    expect(parsePullPercent("abc")).toBe(0);
    expect(parsePullPercent("-5")).toBe(0);
  });
  it("clamps at 100", () => {
    expect(parsePullPercent("150")).toBe(100);
  });
  it("parses integers in range", () => {
    expect(parsePullPercent("50")).toBe(50);
    expect(parsePullPercent("0")).toBe(0);
    expect(parsePullPercent("100")).toBe(100);
  });
});

describe("shouldUsePullTransport", () => {
  it("always returns false for v1 threads regardless of column or percent", () => {
    expect(
      shouldUsePullTransport({
        threadId: "t1",
        messageStorageVersion: 1,
        linkTransport: "pull",
        percent: 100,
      }),
    ).toBe(false);
  });

  it("returns false when percent=0 and column is null", () => {
    expect(
      shouldUsePullTransport({
        threadId: "t1",
        messageStorageVersion: 2,
        linkTransport: null,
        percent: 0,
      }),
    ).toBe(false);
  });

  it("returns true when column is explicitly 'pull' and v2", () => {
    expect(
      shouldUsePullTransport({
        threadId: "t1",
        messageStorageVersion: 2,
        linkTransport: "pull",
        percent: 0,
      }),
    ).toBe(true);
  });

  it("returns false when column is 'ws' even if v2 and percent=100", () => {
    expect(
      shouldUsePullTransport({
        threadId: "t1",
        messageStorageVersion: 2,
        linkTransport: "ws",
        percent: 100,
      }),
    ).toBe(false);
  });

  it("is deterministic for the same threadId (no flipping)", () => {
    const id = "thread-abc-123";
    const a = shouldUsePullTransport({
      threadId: id,
      messageStorageVersion: 2,
      linkTransport: null,
      percent: 50,
    });
    const b = shouldUsePullTransport({
      threadId: id,
      messageStorageVersion: 2,
      linkTransport: null,
      percent: 50,
    });
    expect(a).toBe(b);
  });

  it("percent=100 selects all null-column v2 threads", () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      shouldUsePullTransport({
        threadId: `thread-${i}`,
        messageStorageVersion: 2,
        linkTransport: null,
        percent: 100,
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it("percent=100 with null column and v2 exercises the bucket path and returns true", () => {
    // Explicit test that the FNV-1a bucket path is exercised at percent=100
    expect(
      shouldUsePullTransport({
        threadId: "some-specific-thread-id-for-bucket-exercise",
        messageStorageVersion: 2,
        linkTransport: null,
        percent: 100,
      }),
    ).toBe(true);
  });
});

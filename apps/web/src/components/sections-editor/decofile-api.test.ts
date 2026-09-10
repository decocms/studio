import { describe, expect, it } from "bun:test";
import { CMS_STALE_BRANCH_MS, isBranchStale } from "./decofile-api";

describe("isBranchStale", () => {
  const now = new Date("2026-08-27T12:00:00.000Z").getTime();

  it("is not stale when there is no commit date (default branch / unmaterialized)", () => {
    expect(isBranchStale(null, now)).toBe(false);
    expect(isBranchStale(undefined, now)).toBe(false);
  });

  it("is not stale for a fresh branch cut moments ago", () => {
    const at = new Date(now - 60_000).toISOString();
    expect(isBranchStale(at, now)).toBe(false);
  });

  it("is not stale exactly at the window boundary", () => {
    const at = new Date(now - CMS_STALE_BRANCH_MS).toISOString();
    expect(isBranchStale(at, now)).toBe(false);
  });

  it("is stale one ms past the window", () => {
    const at = new Date(now - CMS_STALE_BRANCH_MS - 1).toISOString();
    expect(isBranchStale(at, now)).toBe(true);
  });

  it("is stale for a branch untouched for 15 days", () => {
    const at = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(isBranchStale(at, now)).toBe(true);
  });

  it("honors a custom window", () => {
    const at = new Date(now - 90 * 60 * 1000).toISOString();
    expect(isBranchStale(at, now, 60 * 60 * 1000)).toBe(true);
    expect(isBranchStale(at, now, 2 * 60 * 60 * 1000)).toBe(false);
  });

  it("treats an unparseable date as not stale", () => {
    expect(isBranchStale("not-a-date", now)).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import type { EnsureOptions } from "../types";
import { earlierShutdown, laterShutdown, stripEnsureOpts } from "./runner";

describe("stripEnsureOpts", () => {
  it("retains orgFsConfigJson so resurrection replays org-fs mounts", () => {
    const opts: EnsureOptions = { orgFsConfigJson: '{"mounts":[]}' };
    expect(stripEnsureOpts(opts)).toEqual({ orgFsConfigJson: '{"mounts":[]}' });
  });

  // The handle no longer depends on this (it comes from `projectRef`), so
  // losing it can't fork a claim the way it once did. Still persisted so a
  // resurrected claim carries the same operator-facing `git-branch` annotation:
  // the synthetic isolation key, not `repo.branch`'s derived git ref.
  it("retains the synthetic branch, not the derived git ref, for the annotation", () => {
    const opts: EnsureOptions = {
      branch: "thread:thrd_1/conn_2",
      repo: {
        cloneUrl: "https://x",
        userName: "u",
        userEmail: "u@e",
        branch: "sandbox/thread-thrd_1-conn_2",
      },
    };
    expect(stripEnsureOpts(opts)?.branch).toBe("thread:thrd_1/conn_2");
  });

  it("drops orgFsConfigJson along with everything else when unset", () => {
    expect(stripEnsureOpts({})).toBeNull();
  });
});

describe("earlierShutdown", () => {
  const target = new Date("2026-08-04T18:00:00.000Z");

  it("brings a later shutdown forward to the target", () => {
    expect(earlierShutdown("2026-08-04T18:15:00.000Z", target)).toBe(
      target.toISOString(),
    );
  });

  it("leaves an already-earlier shutdown alone", () => {
    expect(earlierShutdown("2026-08-04T17:59:00.000Z", target)).toBeNull();
  });

  it("leaves an equal shutdown alone (no pointless write)", () => {
    expect(earlierShutdown(target.toISOString(), target)).toBeNull();
  });

  // The property that keeps this safe: a concurrent turn adopting the same pod
  // patches the TTL out to 15 min; a release firing just after must not undo
  // that and kill a sandbox back in use.
  it("never extends a shutdown a concurrent adopt just pushed out", () => {
    const extended = new Date(target.getTime() + 15 * 60_000).toISOString();
    const result = earlierShutdown(extended, target);
    expect(result).toBe(target.toISOString());
    expect(new Date(result!).getTime()).toBeLessThan(
      new Date(extended).getTime(),
    );
  });

  it("treats an absent shutdownTime as no commitment", () => {
    expect(earlierShutdown(undefined, target)).toBe(target.toISOString());
  });

  it("treats an unparseable shutdownTime as no commitment", () => {
    expect(earlierShutdown("not-a-date", target)).toBe(target.toISOString());
  });
});

describe("laterShutdown", () => {
  const target = new Date("2026-08-04T18:00:00.000Z");

  it("pushes an earlier shutdown out to the target", () => {
    expect(laterShutdown("2026-08-04T17:50:00.000Z", target)).toBe(
      target.toISOString(),
    );
  });

  it("leaves an already-later shutdown alone", () => {
    expect(laterShutdown("2026-08-04T18:10:00.000Z", target)).toBeNull();
  });

  it("leaves an equal shutdown alone (no pointless write)", () => {
    expect(laterShutdown(target.toISOString(), target)).toBeNull();
  });

  // The mirror of earlierShutdown's safety property: a renewal fires from every
  // open event stream, and must never undercut a longer commitment — otherwise
  // watching a sandbox could *shorten* its life.
  it("never shortens a shutdown something else pushed further out", () => {
    const extended = new Date(target.getTime() + 15 * 60_000).toISOString();
    expect(laterShutdown(extended, target)).toBeNull();
  });

  it("treats an absent shutdownTime as no commitment", () => {
    expect(laterShutdown(undefined, target)).toBe(target.toISOString());
  });

  it("treats an unparseable shutdownTime as no commitment", () => {
    expect(laterShutdown("not-a-date", target)).toBe(target.toISOString());
  });
});

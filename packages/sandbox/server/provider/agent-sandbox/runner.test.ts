import { describe, expect, it } from "bun:test";
import type { EnsureOptions } from "../types";
import {
  earlierShutdown,
  freshOrgFsConfigJson,
  laterShutdown,
  stripEnsureOpts,
  withoutCredentials,
} from "./runner";

describe("withoutCredentials", () => {
  const CLONE_TOKEN = "ghs_clonetoken123";
  const SUBMODULE_TOKEN = "ghp_submodule456";
  const API_KEY = "orgfs_apikey789";
  const repo = (path: string) => ({
    cloneUrl: `https://x-access-token:${CLONE_TOKEN}@github.com/acme/${path}.git`,
    connectionId: "c1",
    userName: "u",
    userEmail: "e",
    submoduleCredentials: [{ host: "github.com", token: SUBMODULE_TOKEN }],
  });
  const opts: EnsureOptions = {
    tenant: { orgId: "o1", userId: "u1" },
    repo: repo("site"),
    extraRepos: [repo("docs")],
    orgFsConfigJson: JSON.stringify({ token: API_KEY }),
  };

  it("writes no clone token, submodule token or API key into the state bytes", () => {
    const state = {
      token: "daemon-bearer",
      ...withoutCredentials(opts, false),
    };
    const bytes = JSON.stringify(state);
    for (const secret of [
      CLONE_TOKEN,
      SUBMODULE_TOKEN,
      API_KEY,
      "x-access-token",
    ]) {
      expect(bytes).not.toContain(secret);
    }
    expect(state.ensureOpts.repo?.cloneUrl).toBe(
      "https://github.com/acme/site.git",
    );
    expect(state.ensureOpts.extraRepos?.[0]?.cloneUrl).toBe(
      "https://github.com/acme/docs.git",
    );
    expect(state.orgFsRedacted).toBe(true);
  });

  it("remembers an org-fs mount it already redacted", () => {
    const { orgFsConfigJson: _gone, ...rest } = opts;
    expect(withoutCredentials(rest, true).orgFsRedacted).toBe(true);
    expect(withoutCredentials({ tenant: opts.tenant }, false)).toEqual({
      ensureOpts: { tenant: opts.tenant },
    });
  });

  it("drops a repo whose clone URL it cannot parse", () => {
    const bytes = JSON.stringify(
      withoutCredentials(
        { repo: { ...repo("x"), cloneUrl: `not a url ${CLONE_TOKEN}` } },
        false,
      ),
    );
    expect(bytes).not.toContain(CLONE_TOKEN);
  });
});

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

  // Without this, a recreated warm-pool pod's rebootstrap would compute
  // `cloneOnly: false` from the persisted opts, silently re-enabling install +
  // dev-server for a sandbox provisioned clone-only.
  it("retains cloneOnly so resurrection doesn't silently install/start a dev server", () => {
    const opts: EnsureOptions = { cloneOnly: true };
    expect(stripEnsureOpts(opts)).toEqual({ cloneOnly: true });
  });

  it("drops cloneOnly: false rather than persisting a redundant flag", () => {
    const opts: EnsureOptions = { cloneOnly: false, branch: "b" };
    expect(stripEnsureOpts(opts)).toEqual({ branch: "b" });
  });

  // Lose it and the resurrected claim names the default template + pool again.
  it("retains purpose so a resurrected harness run keeps its own template", () => {
    const opts: EnsureOptions = { purpose: "harness-run", cloneOnly: true };
    expect(stripEnsureOpts(opts)).toEqual({
      purpose: "harness-run",
      cloneOnly: true,
    });
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

describe("freshOrgFsConfigJson", () => {
  const tenant = { orgId: "org_1", userId: "usr_1", orgSlug: "acme" };
  const stale: EnsureOptions = {
    tenant,
    orgFsConfigJson: '{"token":"expired"}',
  };

  it("replaces the persisted config with a freshly minted one", async () => {
    const fresh = await freshOrgFsConfigJson(
      stale,
      async () => '{"token":"live"}',
    );
    expect(fresh).toBe('{"token":"live"}');
  });

  // A dead org-fs key 401s every WebDAV call and the agent sees EIO on every
  // `org/` path, so the fallback must never be "no mounts".
  it("falls back to the persisted config when the minter declines", async () => {
    expect(await freshOrgFsConfigJson(stale, async () => null)).toBe(
      stale.orgFsConfigJson,
    );
  });

  it("falls back when the minter throws", async () => {
    const fresh = await freshOrgFsConfigJson(stale, async () => {
      throw new Error("mint down");
    });
    expect(fresh).toBe(stale.orgFsConfigJson);
  });

  it("keeps the persisted config when the row has no tenant to scope a key to", async () => {
    const untenanted: EnsureOptions = { orgFsConfigJson: '{"token":"old"}' };
    let called = false;
    const fresh = await freshOrgFsConfigJson(untenanted, async () => {
      called = true;
      return '{"token":"live"}';
    });
    expect(fresh).toBe('{"token":"old"}');
    expect(called).toBe(false);
  });
});

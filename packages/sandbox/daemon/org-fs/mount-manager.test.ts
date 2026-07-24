import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@decocms/shared/std";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type InvalidatorFactory,
  type Mounter,
  MountManager,
  type OrgFsMountConfig,
  resolveMountPath,
} from "./mount-manager";
import { parseOrgFsConfig } from "./config";

/**
 * Records invalidator start/stop per volume; never polls or touches rclone rc
 * (keeps these unit tests network-free).
 */
function fakeInvalidators() {
  const started: { volume: string; rcUrl: string }[] = [];
  const stopped: string[] = [];
  const factory: InvalidatorFactory = ({ volume, rcUrl }) => {
    started.push({ volume, rcUrl });
    return { stop: () => stopped.push(volume) };
  };
  return { factory, started, stopped };
}

describe("parseOrgFsConfig", () => {
  const valid = JSON.stringify({
    baseUrl: "http://m",
    orgSlug: "acme",
    token: "t",
    mounts: [{ volume: "skills", path: "skills" }],
  });
  it("parses a valid config", () => {
    expect(parseOrgFsConfig(valid)).toEqual({
      baseUrl: "http://m",
      orgSlug: "acme",
      token: "t",
      mounts: [{ volume: "skills", path: "skills" }],
    });
  });
  it("returns null for absent / malformed / incomplete / empty-mounts", () => {
    expect(parseOrgFsConfig(undefined)).toBeNull();
    expect(parseOrgFsConfig("")).toBeNull();
    expect(parseOrgFsConfig("{not json")).toBeNull();
    expect(parseOrgFsConfig(JSON.stringify({ baseUrl: "x" }))).toBeNull();
    expect(
      parseOrgFsConfig(
        JSON.stringify({ baseUrl: "m", orgSlug: "a", token: "t", mounts: [] }),
      ),
    ).toBeNull();
  });
  it("drops malformed mount entries", () => {
    const c = parseOrgFsConfig(
      JSON.stringify({
        baseUrl: "m",
        orgSlug: "a",
        token: "t",
        mounts: [{ volume: "ok", path: "ok" }, { volume: 1 }, "nope"],
      }),
    );
    expect(c?.mounts).toEqual([{ volume: "ok", path: "ok" }]);
  });
});

/** Records mount/unmount calls; never touches the OS. */
function fakeMounter(opts: { failVolumes?: Set<string> } = {}) {
  const calls: { webdavUrl: string; mountPath: string }[] = [];
  const unmounted: string[] = [];
  // mountPath -> resolver for that mount's `exited`, so a test can simulate an
  // unexpected rclone death with crash(mountPath).
  const exiters = new Map<string, (code: number) => void>();
  const mounter: Mounter = {
    async mount({ webdavUrl, mountPath }) {
      calls.push({ webdavUrl, mountPath });
      // Fail volumes whose mount path ends with a flagged segment.
      for (const v of opts.failVolumes ?? [])
        if (mountPath.endsWith(`/${v}`)) throw new Error(`forced fail ${v}`);
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((res) => {
        resolveExit = res;
      });
      exiters.set(mountPath, resolveExit);
      return {
        exited,
        async unmount() {
          unmounted.push(mountPath);
          resolveExit(0); // mirrors the real handle: unmount resolves exited
        },
      };
    },
  };
  /** Simulate an unexpected rclone death for the mount at `mountPath`. */
  const crash = (mountPath: string) => exiters.get(mountPath)?.(1);
  return { mounter, calls, unmounted, crash };
}

/** Poll until `cond` holds (or throw). For the fire-and-forget death watcher. */
async function waitUntil(cond: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(5);
  if (!cond()) throw new Error("condition not met in time");
}

const config = (
  mounts: { volume: string; path: string }[],
): OrgFsMountConfig => ({
  baseUrl: "http://studio.invalid",
  orgSlug: "acme",
  token: "tok",
  mounts,
});

describe("resolveMountPath", () => {
  it("places relative paths under <appRoot>/org and clamps escapes", () => {
    expect(resolveMountPath("/ws", "skills")).toBe("/ws/org/skills");
    expect(resolveMountPath("/ws", "a/b")).toBe("/ws/org/a/b");
    // traversal out of org/ but still inside appRoot is allowed by the clamp...
    expect(resolveMountPath("/ws", "../tmp")).toBe("/ws/tmp");
    // ...escaping appRoot entirely is rejected
    expect(resolveMountPath("/ws", "../../etc")).toBeNull();
  });
  it("accepts an absolute path only if inside appRoot", () => {
    expect(resolveMountPath("/ws", "/ws/org/x")).toBe("/ws/org/x");
    expect(resolveMountPath("/ws", "/etc/passwd")).toBeNull();
  });
  it("rejects absolute paths that use .. to escape appRoot despite matching its prefix", () => {
    expect(resolveMountPath("/ws", "/ws/../etc/passwd")).toBeNull();
    expect(resolveMountPath("/ws", "/ws/org/../../../etc/passwd")).toBeNull();
  });
});

describe("MountManager", () => {
  let appRoot: string;

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "orgfs-mm-"));
  });
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true });
  });

  it("serves + mounts each volume, then unmounts + stops on stop()", async () => {
    const { mounter, calls, unmounted } = fakeMounter();
    const inv = fakeInvalidators();
    const mm = new MountManager(mounter, () => {}, inv.factory);
    await mm.start(
      config([
        { volume: "skills", path: "skills" },
        { volume: "things", path: "things" },
      ]),
      appRoot,
    );

    expect(calls.length).toBe(2);
    // each got a fresh loopback webdav url + the resolved mount path
    for (const c of calls)
      expect(c.webdavUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(calls.map((c) => c.mountPath).sort()).toEqual([
      join(appRoot, "org/skills"),
      join(appRoot, "org/things"),
    ]);
    expect(
      mm
        .list()
        .map((m) => m.volume)
        .sort(),
    ).toEqual(["skills", "things"]);
    // an invalidator was started per mounted volume, each pointed at a
    // loopback rclone rc URL
    expect(inv.started.map((s) => s.volume).sort()).toEqual([
      "skills",
      "things",
    ]);
    for (const s of inv.started)
      expect(s.rcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await mm.stop();
    expect(unmounted.length).toBe(2);
    expect(inv.stopped.sort()).toEqual(["skills", "things"]);
    expect(mm.list()).toEqual([]);
  });

  it("is boot-safe: a failing mount is skipped, others still mount", async () => {
    const { mounter, unmounted } = fakeMounter({
      failVolumes: new Set(["bad"]),
    });
    const inv = fakeInvalidators();
    const mm = new MountManager(mounter, () => {}, inv.factory);
    await mm.start(
      config([
        { volume: "good", path: "good" },
        { volume: "bad", path: "bad" },
      ]),
      appRoot,
    );
    // only the good one is active; the failed one's server was torn down
    expect(mm.list().map((m) => m.volume)).toEqual(["good"]);
    // no invalidator for the failed mount
    expect(inv.started.map((s) => s.volume)).toEqual(["good"]);
    await mm.stop();
    expect(unmounted).toEqual([join(appRoot, "org/good")]);
  });

  it("skips a mount whose path escapes appRoot without mounting it", async () => {
    const { mounter, calls } = fakeMounter();
    const inv = fakeInvalidators();
    const mm = new MountManager(mounter, () => {}, inv.factory);
    await mm.start(config([{ volume: "evil", path: "../../etc" }]), appRoot);
    expect(calls.length).toBe(0);
    expect(inv.started).toEqual([]);
    expect(mm.list()).toEqual([]);
  });

  it("self-heals: an unexpected rclone exit reclaims + remounts once", async () => {
    const { mounter, calls, unmounted, crash } = fakeMounter();
    const inv = fakeInvalidators();
    const mm = new MountManager(mounter, () => {}, inv.factory);
    await mm.start(config([{ volume: "skills", path: "skills" }]), appRoot);
    const path = join(appRoot, "org/skills");
    expect(calls.length).toBe(1);

    // rclone crashes → reclaim the stale mount, then remount once.
    crash(path);
    await waitUntil(() => calls.length === 2);
    expect(unmounted).toContain(path);
    expect(mm.list().map((m) => m.volume)).toEqual(["skills"]);
    // a fresh invalidator for the remount (started twice total: orig + remount)
    expect(inv.started.filter((s) => s.volume === "skills").length).toBe(2);

    // a SECOND crash does not remount again (one-shot self-heal).
    crash(path);
    await waitUntil(() => mm.list().length === 0);
    expect(calls.length).toBe(2);

    await mm.stop();
  });

  it("win32: skips all volumes, mounts nothing, list() stays empty", async () => {
    const { mounter, calls } = fakeMounter();
    const inv = fakeInvalidators();
    const logs: string[] = [];
    const mm = new MountManager(
      mounter,
      (m) => logs.push(m),
      inv.factory,
      "win32",
    );
    await mm.start(
      config([
        { volume: "skills", path: "skills" },
        { volume: "things", path: "things" },
      ]),
      appRoot,
    );

    // no mounter call at all — not even an attempt that could throw/degrade
    expect(calls.length).toBe(0);
    expect(inv.started).toEqual([]);
    expect(mm.list()).toEqual([]);
    expect(logs.some((m) => /windows/i.test(m) && m.includes("2"))).toBe(true);

    await mm.stop(); // no-op, nothing to unmount
    expect(mm.list()).toEqual([]);
  });

  it("does not remount when the exit comes from a deliberate stop()", async () => {
    const { mounter, calls } = fakeMounter();
    const inv = fakeInvalidators();
    const mm = new MountManager(mounter, () => {}, inv.factory);
    await mm.start(config([{ volume: "skills", path: "skills" }]), appRoot);
    expect(calls.length).toBe(1);

    await mm.stop(); // unmount() resolves exited, but `closing` blocks the watcher
    await sleep(20); // let any stray watcher microtask run
    expect(calls.length).toBe(1); // no remount
    expect(mm.list()).toEqual([]);
  });
});

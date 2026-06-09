import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type Mounter,
  MountManager,
  type OrgFsMountConfig,
  resolveMountPath,
} from "./mount-manager";

/** Records mount/unmount calls; never touches the OS. */
function fakeMounter(opts: { failVolumes?: Set<string> } = {}) {
  const calls: { webdavUrl: string; mountPath: string }[] = [];
  const unmounted: string[] = [];
  const mounter: Mounter = {
    async mount({ webdavUrl, mountPath }) {
      calls.push({ webdavUrl, mountPath });
      // Fail volumes whose mount path ends with a flagged segment.
      for (const v of opts.failVolumes ?? [])
        if (mountPath.endsWith(`/${v}`)) throw new Error(`forced fail ${v}`);
      return {
        async unmount() {
          unmounted.push(mountPath);
        },
      };
    },
  };
  return { mounter, calls, unmounted };
}

const config = (
  mounts: { volume: string; path: string }[],
): OrgFsMountConfig => ({
  baseUrl: "http://mesh.invalid",
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
    const mm = new MountManager(mounter, () => {});
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

    await mm.stop();
    expect(unmounted.length).toBe(2);
    expect(mm.list()).toEqual([]);
  });

  it("is boot-safe: a failing mount is skipped, others still mount", async () => {
    const { mounter, unmounted } = fakeMounter({
      failVolumes: new Set(["bad"]),
    });
    const mm = new MountManager(mounter, () => {});
    await mm.start(
      config([
        { volume: "good", path: "good" },
        { volume: "bad", path: "bad" },
      ]),
      appRoot,
    );
    // only the good one is active; the failed one's server was torn down
    expect(mm.list().map((m) => m.volume)).toEqual(["good"]);
    await mm.stop();
    expect(unmounted).toEqual([join(appRoot, "org/good")]);
  });

  it("skips a mount whose path escapes appRoot without mounting it", async () => {
    const { mounter, calls } = fakeMounter();
    const mm = new MountManager(mounter, () => {});
    await mm.start(config([{ volume: "evil", path: "../../etc" }]), appRoot);
    expect(calls.length).toBe(0);
    expect(mm.list()).toEqual([]);
  });
});

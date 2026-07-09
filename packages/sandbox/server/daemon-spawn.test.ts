import { describe, expect, it } from "bun:test";
import {
  buildSandboxDaemonSpawnCommand,
  canHotReloadDaemon,
  deriveNodeModulesDir,
  resolveDaemonStdio,
  sandboxDaemonLogPath,
} from "./daemon-spawn";

describe("deriveNodeModulesDir", () => {
  it("derives the node_modules dir from a POSIX node-pty resolution", () => {
    expect(
      deriveNodeModulesDir(
        "/Users/me/project/node_modules/node-pty/lib/index.js",
      ),
    ).toBe("/Users/me/project/node_modules");
  });

  it("derives the node_modules dir from a Windows node-pty resolution", () => {
    expect(
      deriveNodeModulesDir(
        "C:\\Users\\me\\AppData\\Local\\Temp\\bunx-123\\node_modules\\node-pty\\lib\\index.js",
      ),
    ).toBe("C:\\Users\\me\\AppData\\Local\\Temp\\bunx-123\\node_modules");
  });

  it("throws when the path has no node_modules segment", () => {
    expect(() =>
      deriveNodeModulesDir("/Users/me/project/lib/index.js"),
    ).toThrow("could not derive node_modules path from node-pty resolution");
  });
});

describe("resolveDaemonStdio", () => {
  it("inherits the parent fds when no log fd is given", () => {
    expect(resolveDaemonStdio()).toBe("inherit");
    expect(resolveDaemonStdio(undefined)).toBe("inherit");
  });

  it("returns the provided fd so the child writes to the log file", () => {
    expect(resolveDaemonStdio(7)).toBe(7);
  });
});

describe("sandboxDaemonLogPath", () => {
  it("co-locates the per-sandbox daemon log under the sandbox's tmp/", () => {
    expect(
      sandboxDaemonLogPath("/Users/me/deco/sandboxes/thin-crest-abc123"),
    ).toBe("/Users/me/deco/sandboxes/thin-crest-abc123/tmp/daemon.log");
  });

  it("is a sibling of the sandbox repo/, not inside it", () => {
    const workdir = "/data/sandboxes/h1";
    expect(sandboxDaemonLogPath(workdir)).not.toContain("/repo/");
    expect(sandboxDaemonLogPath(workdir)).toBe(
      "/data/sandboxes/h1/tmp/daemon.log",
    );
  });
});

describe("canHotReloadDaemon", () => {
  it("is false when hotReload is not requested, even if paths match", () => {
    expect(
      canHotReloadDaemon({
        daemonExec: "/repo/packages/sandbox/daemon/entry.ts",
        sourceDaemonPath: "/repo/packages/sandbox/daemon/entry.ts",
      }),
    ).toBe(false);
  });

  it("is false when hotReload is requested but the daemon is a materialized bundle", () => {
    expect(
      canHotReloadDaemon({
        daemonExec: "/tmp/cache/sandbox-daemon-deadbeef.js",
        sourceDaemonPath: "/repo/packages/sandbox/daemon/entry.ts",
        hotReload: true,
      }),
    ).toBe(false);
  });

  it("is true when hotReload is requested and paths resolve to the same file, even with a non-normalized path", () => {
    expect(
      canHotReloadDaemon({
        daemonExec: "/repo/packages/sandbox/daemon/../daemon/entry.ts",
        sourceDaemonPath: "/repo/packages/sandbox/daemon/entry.ts",
        hotReload: true,
      }),
    ).toBe(true);
  });
});

describe("buildSandboxDaemonSpawnCommand", () => {
  it("adds Bun hot reload when the daemon is running from source", () => {
    expect(
      buildSandboxDaemonSpawnCommand({
        daemonExec: "/repo/packages/sandbox/daemon/entry.ts",
        sourceDaemonPath: "/repo/packages/sandbox/daemon/entry.ts",
        hotReload: true,
      }),
    ).toEqual([
      "bun",
      "--hot",
      "run",
      "/repo/packages/sandbox/daemon/entry.ts",
    ]);
  });

  it("does not add Bun hot reload for a materialized daemon bundle", () => {
    expect(
      buildSandboxDaemonSpawnCommand({
        daemonExec: "/tmp/cache/sandbox-daemon-deadbeef.js",
        sourceDaemonPath: "/repo/packages/sandbox/daemon/entry.ts",
        hotReload: true,
      }),
    ).toEqual(["bun", "run", "/tmp/cache/sandbox-daemon-deadbeef.js"]);
  });
});

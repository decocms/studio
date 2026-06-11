import { describe, expect, it } from "bun:test";
import {
  buildSandboxDaemonSpawnCommand,
  resolveDaemonStdio,
} from "./daemon-spawn";

describe("resolveDaemonStdio", () => {
  it("inherits the parent fds when no log fd is given", () => {
    expect(resolveDaemonStdio()).toBe("inherit");
    expect(resolveDaemonStdio(undefined)).toBe("inherit");
  });

  it("returns the provided fd so the child writes to the log file", () => {
    expect(resolveDaemonStdio(7)).toBe(7);
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

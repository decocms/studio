import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runSidecar, type SidecarMountManager } from "./sidecar";

/** Records start/stop; reports the started volumes as mounted. */
function fakeManager() {
  const calls: { config: unknown; appRoot: string }[] = [];
  let stopped = 0;
  let mounts: { volume: string; mountPath: string }[] = [];
  const manager: SidecarMountManager = {
    async start(config, appRoot) {
      calls.push({ config, appRoot });
      mounts = config.mounts.map((m) => ({
        volume: m.volume,
        mountPath: join(appRoot, "org", m.path),
      }));
    },
    async stop() {
      stopped++;
      mounts = [];
    },
    list: () => mounts,
  };
  return { manager, calls, stopped: () => stopped };
}

const CONFIG = JSON.stringify({
  baseUrl: "http://studio",
  orgSlug: "acme",
  token: "t",
  mounts: [{ volume: "skills", path: "skills" }],
});

describe("runSidecar", () => {
  let dir: string;
  const configPath = () => join(dir, "config.json");
  const statusPath = () => join(dir, "status.json");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orgfs-sc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("waits for the config file, mounts, writes status, unmounts on abort", async () => {
    const { manager, calls, stopped } = fakeManager();
    const ac = new AbortController();
    const run = runSidecar({
      configPath: configPath(),
      statusPath: statusPath(),
      appRoot: "/app",
      manager,
      signal: ac.signal,
      pollMs: 5,
    });
    // no config yet → nothing mounted
    await Bun.sleep(20);
    expect(calls.length).toBe(0);

    writeFileSync(configPath(), CONFIG);
    await Bun.sleep(40);
    expect(calls.length).toBe(1);
    expect(calls[0]?.appRoot).toBe("/app");
    const status = JSON.parse(readFileSync(statusPath(), "utf8"));
    expect(status.mounts).toEqual([
      { volume: "skills", mountPath: "/app/org/skills" },
    ]);

    ac.abort();
    await run;
    expect(stopped()).toBe(1);
  });

  it("ignores an invalid config file and keeps waiting", async () => {
    const { manager, calls } = fakeManager();
    const ac = new AbortController();
    writeFileSync(configPath(), "{not json");
    const run = runSidecar({
      configPath: configPath(),
      statusPath: statusPath(),
      appRoot: "/app",
      manager,
      signal: ac.signal,
      pollMs: 5,
    });
    await Bun.sleep(25);
    expect(calls.length).toBe(0);
    writeFileSync(configPath(), CONFIG);
    await Bun.sleep(40);
    expect(calls.length).toBe(1);
    ac.abort();
    await run;
  });

  it("exits without mounting when aborted while waiting", async () => {
    const { manager, calls, stopped } = fakeManager();
    const ac = new AbortController();
    const run = runSidecar({
      configPath: configPath(),
      statusPath: statusPath(),
      appRoot: "/app",
      manager,
      signal: ac.signal,
      pollMs: 5,
    });
    await Bun.sleep(15);
    ac.abort();
    await run;
    expect(calls.length).toBe(0);
    expect(stopped()).toBe(1); // stop() is safe on an idle manager
  });

  it("creates the status file's parent dir", async () => {
    const { manager } = fakeManager();
    const ac = new AbortController();
    const nested = join(dir, "deep", "status.json");
    writeFileSync(configPath(), CONFIG);
    const run = runSidecar({
      configPath: configPath(),
      statusPath: nested,
      appRoot: "/app",
      manager,
      signal: ac.signal,
      pollMs: 5,
    });
    await Bun.sleep(40);
    expect(JSON.parse(readFileSync(nested, "utf8")).mounts.length).toBe(1);
    ac.abort();
    await run;
  });
});

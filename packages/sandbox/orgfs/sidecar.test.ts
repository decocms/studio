import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@decocms/shared/std";
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

function sidecarLogSignals() {
  const invalidConfigRead = Promise.withResolvers<void>();
  const mounted = Promise.withResolvers<void>();
  return {
    invalidConfigRead: invalidConfigRead.promise,
    mounted: mounted.promise,
    log(message: string) {
      if (message === "invalid org-fs config file; waiting for rewrite") {
        invalidConfigRead.resolve();
      }
      if (message.startsWith("mounted ")) {
        mounted.resolve();
      }
    },
  };
}

async function waitForSignal(
  signal: Promise<void>,
  description: string,
): Promise<void> {
  const timeoutController = new AbortController();
  const timeout = sleep(1_000, { signal: timeoutController.signal }).then(
    () => {
      throw new Error(`timed out waiting for ${description}`);
    },
  );
  try {
    await Promise.race([signal, timeout]);
  } finally {
    timeoutController.abort();
    await timeout.catch(() => {});
  }
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
    const signals = sidecarLogSignals();
    const ac = new AbortController();
    const run = runSidecar({
      configPath: configPath(),
      statusPath: statusPath(),
      appRoot: "/app",
      manager,
      signal: ac.signal,
      pollMs: 5,
      log: signals.log,
    });

    try {
      // no config yet → nothing mounted
      await sleep(20);
      expect(calls.length).toBe(0);

      writeFileSync(configPath(), CONFIG);
      await waitForSignal(signals.mounted, "sidecar mount");
      expect(calls.length).toBe(1);
      expect(calls[0]?.appRoot).toBe("/app");
      const status = JSON.parse(readFileSync(statusPath(), "utf8"));
      expect(status.mounts).toEqual([
        { volume: "skills", mountPath: "/app/org/skills" },
      ]);
    } finally {
      ac.abort();
      await run;
    }
    expect(stopped()).toBe(1);
  });

  it("ignores an invalid config file and keeps waiting", async () => {
    const { manager, calls } = fakeManager();
    const signals = sidecarLogSignals();
    const ac = new AbortController();
    writeFileSync(configPath(), "{not json");
    const run = runSidecar({
      configPath: configPath(),
      statusPath: statusPath(),
      appRoot: "/app",
      manager,
      signal: ac.signal,
      pollMs: 5,
      log: signals.log,
    });
    try {
      await waitForSignal(signals.invalidConfigRead, "invalid config read");
      expect(calls.length).toBe(0);
      writeFileSync(configPath(), CONFIG);
      await waitForSignal(signals.mounted, "sidecar mount");
      expect(calls.length).toBe(1);
    } finally {
      ac.abort();
      await run;
    }
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
    await sleep(15);
    ac.abort();
    await run;
    expect(calls.length).toBe(0);
    expect(stopped()).toBe(1); // stop() is safe on an idle manager
  });

  it("creates the status file's parent dir", async () => {
    const { manager } = fakeManager();
    const signals = sidecarLogSignals();
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
      log: signals.log,
    });
    try {
      await waitForSignal(signals.mounted, "sidecar mount");
      expect(JSON.parse(readFileSync(nested, "utf8")).mounts.length).toBe(1);
    } finally {
      ac.abort();
      await run;
    }
  });
});

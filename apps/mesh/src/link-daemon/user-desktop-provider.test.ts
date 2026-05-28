import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopSandboxProvider } from "./user-desktop-provider";

function fakeDaemonSpawner() {
  return {
    port: 12345,
    kill: () => {},
  };
}

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "link-prov-"));
}

describe("desktop sandbox provider", () => {
  it("creates a sandbox and returns sandboxApiUrl", async () => {
    const dataDir = tmpDataDir();
    try {
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
      });
      const { sandboxApiUrl, port } = await provider.ensureSandbox({
        handle: "abc",
        repo: undefined,
      });
      expect(sandboxApiUrl).toBe(`http://127.0.0.1:${port}`);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("re-attaches to an existing sandbox on idempotent create", async () => {
    const dataDir = tmpDataDir();
    try {
      let spawnCount = 0;
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => {
          spawnCount++;
          return fakeDaemonSpawner();
        },
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
        // Cache-hit path now probes /health; mock as alive so the second
        // ensureSandbox re-attaches instead of evicting + respawning.
        fetchImpl: (async () =>
          new Response("", { status: 200 })) as unknown as typeof fetch,
      });
      await provider.ensureSandbox({ handle: "abc", repo: undefined });
      await provider.ensureSandbox({ handle: "abc", repo: undefined });
      expect(spawnCount).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("evicts and respawns when the cached daemon fails /health", async () => {
    // Spawned daemon dies in a way that doesn't resolve `exited` (the
    // realistic failure mode — laptop sleep, OOM kill, tunnel drop).
    // The watchdog misses it, but the cache-hit probe must catch it
    // and force a respawn instead of returning the stale URL.
    const dataDir = tmpDataDir();
    try {
      let spawnCount = 0;
      let portCounter = 30000;
      let healthAlive = true;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => {
          spawnCount++;
          return fakeDaemonSpawner();
        },
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
        fetchImpl: (async () =>
          new Response("", {
            status: healthAlive ? 200 : 503,
          })) as unknown as typeof fetch,
      });
      await provider.ensureSandbox({ handle: "abc", repo: undefined });
      // Daemon "dies" — /health starts failing.
      healthAlive = false;
      await provider.ensureSandbox({ handle: "abc", repo: undefined });
      expect(spawnCount).toBe(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("LRU-evicts when the cap is exceeded", async () => {
    const dataDir = tmpDataDir();
    try {
      let spawnCount = 0;
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => {
          spawnCount++;
          return fakeDaemonSpawner();
        },
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
        maxSandboxes: 2,
      });
      await provider.ensureSandbox({ handle: "a", repo: undefined });
      // Slight delay so "b" has a strictly later lastUsedAt than "a".
      await new Promise((r) => setTimeout(r, 2));
      await provider.ensureSandbox({ handle: "b", repo: undefined });
      await new Promise((r) => setTimeout(r, 2));
      await provider.ensureSandbox({ handle: "c", repo: undefined });
      // "a" should have been evicted (it was the LRU when "c" arrived).
      expect(spawnCount).toBe(3);
      expect(
        provider
          .listSandboxes()
          .map((s) => s.handle)
          .sort(),
      ).toEqual(["b", "c"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("clears the map entry when the daemon process exits unexpectedly", async () => {
    let exitResolver: (() => void) | null = null;
    const exitPromise = new Promise<void>((r) => {
      exitResolver = r;
    });

    const provider = createDesktopSandboxProvider({
      dataDir: "/tmp/test",
      spawnDaemon: async ({ port }) => ({
        port,
        kill: () => {},
        exited: exitPromise,
      }),
      postConfig: async () => {},
      waitForHealth: async () => {},
      pickPort: (() => {
        let n = 50_300;
        return () => n++;
      })(),
    });

    await provider.ensureSandbox({ handle: "crash-me" });
    expect(provider.listSandboxes()).toHaveLength(1);

    exitResolver!();
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.listSandboxes()).toHaveLength(0);
  });
});

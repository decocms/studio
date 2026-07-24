import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openLinkSandboxRegistry,
  registryPathForDataDir,
  type LinkSandboxRegistry,
} from "../cli/link-sandbox-registry";
import {
  createDesktopSandboxProvider,
  type SandboxEvent,
} from "./user-desktop-provider";

function fakeDaemonSpawner() {
  return {
    port: 12345,
    kill: () => {},
  };
}

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "link-prov-"));
}

function fakeRegistry(): {
  registry: LinkSandboxRegistry;
  upserts: Parameters<LinkSandboxRegistry["upsert"]>[0][];
} {
  const upserts: Parameters<LinkSandboxRegistry["upsert"]>[0][] = [];
  return {
    upserts,
    registry: {
      upsert: (row) => upserts.push(row),
      list: () => [],
      reconcile: () => [],
      prune: () => ({ removed: [], skipped: [] }),
      delete: () => {},
      inspect: () => null,
      close: () => {},
    },
  };
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

  it("emits spawning then ready events via onEvent", async () => {
    const dataDir = tmpDataDir();
    try {
      const events: SandboxEvent[] = [];
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
        onEvent: (e) => events.push(e),
      });
      await provider.ensureSandbox({ handle: "abc", repo: undefined });
      const phases = events
        .filter((e) => e.handle === "abc")
        .map((e) => e.phase);
      expect(phases).toContain("spawning");
      expect(phases).toContain("ready");
      expect(phases.indexOf("spawning")).toBeLessThan(phases.indexOf("ready"));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("carries projectName/branch on spawning and ready events", async () => {
    const dataDir = tmpDataDir();
    try {
      const events: SandboxEvent[] = [];
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
        onEvent: (e) => events.push(e),
      });
      await provider.ensureSandbox({
        handle: "abc",
        repo: {
          cloneUrl: "https://github.com/decocms/studio.git",
          branch: "alpha-hydrae",
        },
      });
      const lifecycle = events.filter((e) => e.handle === "abc");
      for (const phase of ["spawning", "ready"] as const) {
        expect(lifecycle.find((e) => e.phase === phase)).toEqual(
          expect.objectContaining({
            branch: "alpha-hydrae",
            projectName: "studio",
          }),
        );
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists ready and deleted lifecycle transitions to the registry", async () => {
    const dataDir = tmpDataDir();
    try {
      const { registry, upserts } = fakeRegistry();
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        registry,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
        resolvePreviewUrl: (handle, port) =>
          `http://${handle}.localhost:${port}`,
      });

      await provider.ensureSandbox({
        handle: "abc",
        repo: {
          cloneUrl: "https://github.com/decocms/studio.git",
          branch: "alpha-hydrae",
        },
      });
      await provider.deleteSandbox("abc");

      expect(upserts).toEqual([
        {
          handle: "abc",
          status: "spawning",
          sandboxPath: join(dataDir, "sandboxes", "abc"),
          port: null,
          previewUrl: null,
          repoCloneUrl: "https://github.com/decocms/studio.git",
          branch: "alpha-hydrae",
          projectName: "studio",
          error: null,
        },
        {
          handle: "abc",
          status: "ready",
          sandboxPath: join(dataDir, "sandboxes", "abc"),
          port: 30000,
          previewUrl: "http://abc.localhost:30000",
          repoCloneUrl: "https://github.com/decocms/studio.git",
          branch: "alpha-hydrae",
          projectName: "studio",
          error: null,
        },
        {
          handle: "abc",
          status: "stopped",
          sandboxPath: join(dataDir, "sandboxes", "abc"),
          port: null,
          previewUrl: null,
          repoCloneUrl: null,
          branch: null,
          projectName: null,
          error: null,
        },
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses to delete a sandbox while a dispatch is in flight (a reap must not kill a live run)", async () => {
    const dataDir = tmpDataDir();
    try {
      let killed = 0;
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => ({
          port: 12345,
          kill: () => {
            killed++;
          },
        }),
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
      });
      await provider.ensureSandbox({ handle: "abc", repo: undefined });

      // A run is streaming on the sandbox — the work item holds the dispatch.
      const release = provider.acquireDispatch("abc");

      // A transient FS-op timeout reaps the handle (DELETE /api/sandboxes/abc)
      // mid-dispatch. The live sandbox MUST survive: killing it closes the SSE
      // pump and the run dies with "missing seq" at projection.
      await provider.deleteSandbox("abc");
      expect(killed).toBe(0);
      expect(provider.hasHandle("abc")).toBe(true);
      expect(provider.proxyPort("abc")).toBe(30000);

      // Once the dispatch settles and releases the pin, delete proceeds.
      release();
      await provider.deleteSandbox("abc");
      expect(killed).toBe(1);
      expect(provider.hasHandle("abc")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not create registry rows when deleting an unknown handle", async () => {
    const dataDir = tmpDataDir();
    try {
      const { registry, upserts } = fakeRegistry();
      const provider = createDesktopSandboxProvider({
        dataDir,
        registry,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {},
      });

      await provider.deleteSandbox("missing");

      expect(upserts).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists failed when setup fails before daemon health checks", async () => {
    const dataDir = tmpDataDir();
    try {
      const { registry, upserts } = fakeRegistry();
      const provider = createDesktopSandboxProvider({
        dataDir,
        registry,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => {
          throw new Error("no port available");
        },
      });

      await expect(
        provider.ensureSandbox({
          handle: "early-fail",
          repo: {
            cloneUrl: "git@github.com:decocms/studio.git",
            branch: "alpha-hydrae",
          },
        }),
      ).rejects.toThrow("no port available");

      expect(upserts).toEqual([
        {
          handle: "early-fail",
          status: "spawning",
          sandboxPath: join(dataDir, "sandboxes", "early-fail"),
          port: null,
          previewUrl: null,
          repoCloneUrl: "git@github.com:decocms/studio.git",
          branch: "alpha-hydrae",
          projectName: "studio",
          error: null,
        },
        {
          handle: "early-fail",
          status: "failed",
          sandboxPath: join(dataDir, "sandboxes", "early-fail"),
          port: null,
          previewUrl: null,
          repoCloneUrl: "git@github.com:decocms/studio.git",
          branch: "alpha-hydrae",
          projectName: "studio",
          error: "no port available",
        },
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves registry metadata after delete writes a stopped row", async () => {
    const dataDir = tmpDataDir();
    const registry = openLinkSandboxRegistry({
      path: registryPathForDataDir(dataDir),
      managedSandboxRoot: join(dataDir, "sandboxes"),
    });
    try {
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        registry,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {},
        pickPort: () => portCounter++,
      });

      await provider.ensureSandbox({
        handle: "sticky",
        repo: {
          cloneUrl: "https://github.com/decocms/studio.git",
          branch: "feature/sticky",
        },
      });
      await provider.deleteSandbox("sticky");

      expect(registry.list()).toEqual([
        expect.objectContaining({
          handle: "sticky",
          status: "stopped",
          port: null,
          previewUrl: null,
          repoCloneUrl: "https://github.com/decocms/studio.git",
          branch: "feature/sticky",
          projectName: "studio",
          error: null,
        }),
      ]);
    } finally {
      registry.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("emits a failed event when bring-up throws", async () => {
    const dataDir = tmpDataDir();
    try {
      const events: SandboxEvent[] = [];
      let portCounter = 30000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {
          throw new Error("boom");
        },
        pickPort: () => portCounter++,
        onEvent: (e) => events.push(e),
      });
      await expect(
        provider.ensureSandbox({ handle: "xyz", repo: undefined }),
      ).rejects.toThrow();
      const failed = events.find(
        (e) => e.handle === "xyz" && e.phase === "failed",
      );
      expect(failed?.error).toContain("boom");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("throws a marked, user-facing error when the health check fails", async () => {
    const dataDir = tmpDataDir();
    try {
      let portCounter = 31000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {
          throw new Error("did not respond on /health within 5s");
        },
        pickPort: () => portCounter++,
      });
      const err = (await provider
        .ensureSandbox({ handle: "h1", repo: undefined })
        .catch((e) => e)) as Error;
      expect(err.message).toContain("sandbox failed to start");
      expect(err.message.toLowerCase()).toContain("come online");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("throws a marked error identifying the config step on a config timeout", async () => {
    const dataDir = tmpDataDir();
    try {
      let portCounter = 32000;
      const timeout = new Error("The operation timed out.");
      timeout.name = "TimeoutError";
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => fakeDaemonSpawner(),
        waitForHealth: async () => {},
        postConfig: async () => {
          throw timeout;
        },
        pickPort: () => portCounter++,
      });
      const err = (await provider
        .ensureSandbox({ handle: "h2", repo: undefined })
        .catch((e) => e)) as Error;
      expect(err.message).toContain("sandbox failed to start");
      expect(err.message.toLowerCase()).toContain("config");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("logs a config timeout bring-up failure at warn, not error", async () => {
    const dataDir = tmpDataDir();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let portCounter = 33000;
      const timeout = new Error("The operation timed out.");
      timeout.name = "TimeoutError";
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => fakeDaemonSpawner(),
        waitForHealth: async () => {},
        postConfig: async () => {
          throw timeout;
        },
        pickPort: () => portCounter++,
      });
      await provider
        .ensureSandbox({ handle: "h3", repo: undefined })
        .catch(() => {});

      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes("sandbox bring-up failed"),
        ),
      ).toBe(false);
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes("sandbox bring-up failed"),
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("logs a non-timeout bring-up failure at error", async () => {
    const dataDir = tmpDataDir();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      let portCounter = 34000;
      const provider = createDesktopSandboxProvider({
        dataDir,
        spawnDaemon: () => fakeDaemonSpawner(),
        postConfig: async () => {},
        waitForHealth: async () => {
          throw new Error("boom");
        },
        pickPort: () => portCounter++,
      });
      await provider
        .ensureSandbox({ handle: "h4", repo: undefined })
        .catch(() => {});

      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes("sandbox bring-up failed"),
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
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

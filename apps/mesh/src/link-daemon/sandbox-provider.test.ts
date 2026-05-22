import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopSandboxProvider } from "./sandbox-provider";

function fakeDaemonSpawner() {
  return {
    port: 12345,
    kill: () => {},
  };
}

function nullTunnelOpener() {
  return async () => null;
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
        openDaemonTunnel: async ({ subDomain }) => ({
          publicUrl: `https://${subDomain}`,
          closed: new Promise<void>(() => {}),
          close: () => {},
        }),
        pickPort: () => portCounter++,
      });
      const { sandboxApiUrl } = await provider.ensureSandbox({
        handle: "abc",
        repo: undefined,
      });
      expect(sandboxApiUrl).toBe("https://abc.deco.host");
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
        openDaemonTunnel: nullTunnelOpener(),
        pickPort: () => portCounter++,
      });
      await provider.ensureSandbox({ handle: "abc", repo: undefined });
      await provider.ensureSandbox({ handle: "abc", repo: undefined });
      expect(spawnCount).toBe(1);
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
        openDaemonTunnel: nullTunnelOpener(),
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
});

describe("DesktopSandboxProvider tunnel lifecycle", () => {
  it("opens a tunnel after postConfig and returns the public URL", async () => {
    const tunnelHandles: Array<{ subDomain: string }> = [];

    const provider = createDesktopSandboxProvider({
      dataDir: "/tmp/test",
      spawnDaemon: async ({ port }) => ({ port, kill: () => {} }),
      postConfig: async () => {},
      waitForHealth: async () => {},
      openDaemonTunnel: async ({ subDomain }) => {
        tunnelHandles.push({ subDomain });
        return {
          publicUrl: `https://${subDomain}`,
          closed: new Promise<void>(() => {}),
          close: () => {},
        };
      },
      pickPort: (() => {
        let n = 50_000;
        return () => n++;
      })(),
    });

    const { sandboxApiUrl, port } = await provider.ensureSandbox({
      handle: "test-handle-abc",
    });
    expect(sandboxApiUrl).toBe("https://test-handle-abc.deco.host");
    expect(port).toBe(50_000);
    expect(tunnelHandles).toHaveLength(1);
    expect(tunnelHandles[0]?.subDomain).toBe("test-handle-abc.deco.host");
  });

  it("falls back to 127.0.0.1 URL when openDaemonTunnel returns null", async () => {
    const provider = createDesktopSandboxProvider({
      dataDir: "/tmp/test",
      spawnDaemon: async ({ port }) => ({ port, kill: () => {} }),
      postConfig: async () => {},
      waitForHealth: async () => {},
      openDaemonTunnel: async () => null,
      pickPort: (() => {
        let n = 50_100;
        return () => n++;
      })(),
    });

    const { sandboxApiUrl } = await provider.ensureSandbox({
      handle: "test-handle-xyz",
    });
    expect(sandboxApiUrl).toBe("http://127.0.0.1:50100");
  });

  it("closes the tunnel on deleteSandbox", async () => {
    const closes: string[] = [];
    const provider = createDesktopSandboxProvider({
      dataDir: "/tmp/test",
      spawnDaemon: async ({ port }) => ({ port, kill: () => {} }),
      postConfig: async () => {},
      waitForHealth: async () => {},
      openDaemonTunnel: async ({ subDomain }) => ({
        publicUrl: `https://${subDomain}`,
        closed: new Promise<void>(() => {}),
        close: () => closes.push(subDomain),
      }),
      pickPort: (() => {
        let n = 50_200;
        return () => n++;
      })(),
    });

    await provider.ensureSandbox({ handle: "close-me" });
    await provider.deleteSandbox("close-me");
    expect(closes).toEqual(["close-me.deco.host"]);
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
      openDaemonTunnel: async ({ subDomain }) => ({
        publicUrl: `https://${subDomain}`,
        closed: new Promise<void>(() => {}),
        close: () => {},
      }),
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

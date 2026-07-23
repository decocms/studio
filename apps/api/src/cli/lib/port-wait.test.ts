import { afterEach, describe, expect, it } from "bun:test";
import { type Server, createServer } from "node:net";
import { findRunningAddr, waitForPort } from "./port-wait";

const openServers: Server[] = [];

async function listenOn(host: string, port: number): Promise<void> {
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, () => resolve());
  });
  openServers.push(srv);
}

async function ephemeralPort(): Promise<number> {
  const srv = createServer();
  return new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

afterEach(() => {
  while (openServers.length) {
    const srv = openServers.pop();
    srv?.close();
  }
});

describe("findRunningAddr", () => {
  it("returns null when the port is unused", async () => {
    const port = await ephemeralPort();
    expect(await findRunningAddr(port)).toBeNull();
  });

  it("returns the host when something is listening", async () => {
    const port = await ephemeralPort();
    await listenOn("127.0.0.1", port);
    expect(await findRunningAddr(port)).toBe("127.0.0.1");
  });

  it("returns null when bind fails for a non-EADDRINUSE reason", async () => {
    // Privileged port < 1024 returns EACCES for non-root users on POSIX.
    // On platforms where this somehow succeeds (e.g., macOS recent versions
    // allow port 80 in some configs), skip the test.
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return; // skip on Windows or when running as root
    }
    // Probe all localhost-flavoured addresses that findRunningAddr probes.
    // If ANY of them allow binding port 80 without EACCES, this environment
    // doesn't restrict privileged ports — skip to avoid false failures.
    const hosts = ["localhost", "127.0.0.1", "0.0.0.0"];
    for (const host of hosts) {
      const code = await new Promise<string | undefined>((resolve) => {
        const probe = createServer();
        probe.once("error", (err: NodeJS.ErrnoException) => {
          resolve(err.code);
        });
        probe.listen(80, host, () => {
          probe.close(() => resolve(undefined));
        });
      });
      if (code !== "EACCES") return; // platform allows binding or different error; skip
    }
    expect(await findRunningAddr(80)).toBeNull();
  });
});

describe("waitForPort", () => {
  it("resolves immediately when the port is already in use", async () => {
    const port = await ephemeralPort();
    await listenOn("127.0.0.1", port);
    expect(await waitForPort(port, { intervalMs: 10 })).toBe("127.0.0.1");
  });

  it("waits until the port becomes available, then resolves", async () => {
    const port = await ephemeralPort();
    const promise = waitForPort(port, { intervalMs: 20 });
    setTimeout(() => {
      void listenOn("127.0.0.1", port);
    }, 60);
    expect(await promise).toBe("127.0.0.1");
  });
});

/**
 * The sandbox content protocol over the REAL sandbox daemon: the Go daemon
 * built from `packages/sandbox/daemon-go` (`go build -o bin/daemon .`, or
 * `DAEMON_E2E_CMD`), which knows nothing of the protocol. Studio's route runs
 * it over the daemon's file routes; this proves the same suites the unit test
 * runs over a stand-in (content-storage-test-helpers.ts), plus what only the
 * real daemon does: a protocol write reaches its `/_sandbox/decofile` and its
 * `file-changed` event, like any other write to the working tree.
 *
 * Skipped when no daemon binary is built. The Sandbox workflow builds one.
 */

import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineSandboxContentSuites,
  rpc,
  sandboxRoute,
  seedSite,
  type SandboxUnderTest,
} from "./content-storage-test-helpers";

const DEFAULT_BINARY = join(
  import.meta.dir,
  "../../../../packages/sandbox/daemon-go/bin/daemon",
);
const DAEMON_CMD = process.env.DAEMON_E2E_CMD?.trim()
  ? process.env.DAEMON_E2E_CMD.trim().split(/\s+/)
  : [DEFAULT_BINARY];
const TOKEN = "t".repeat(32);
const available = existsSync(DAEMON_CMD[0]!);

interface Daemon extends SandboxUnderTest {
  port: number;
  proc: ChildProcess;
  appDir: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function startDaemon(): Promise<Daemon> {
  const appDir = mkdtempSync(join(tmpdir(), "sandbox-content-e2e-"));
  const port = await freePort();
  const [cmd, ...args] = DAEMON_CMD;
  const proc = spawn(cmd!, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      DAEMON_TOKEN: TOKEN,
      DAEMON_BOOT_ID: `boot-${port}`,
      APP_ROOT: appDir,
      PROXY_PORT: String(port),
      LOCAL_API_TOKEN_STORE: "memory",
    },
  });
  let stderr = "";
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`daemon exited: ${stderr.slice(-2000)}`);
    }
    const up = await fetch(`http://localhost:${port}/health`).catch(() => null);
    if (up?.ok) break;
    if (Date.now() > deadline) throw new Error("daemon did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
  const repoDir = join(appDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  return {
    port,
    proc,
    appDir,
    repoDir,
    // What `SandboxProvider.proxyDaemonRequest` does: the daemon's own
    // bearer token on a request Studio already authorized.
    proxyDaemonRequest: (_claim, path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${TOKEN}`);
      return fetch(`http://localhost:${port}${path}`, { ...init, headers });
    },
  };
}

async function stopDaemon(sandbox: SandboxUnderTest): Promise<void> {
  const daemon = sandbox as Daemon;
  if (daemon.proc.exitCode === null) {
    await new Promise<void>((resolve) => {
      daemon.proc.once("exit", () => resolve());
      daemon.proc.kill("SIGTERM");
      setTimeout(() => daemon.proc.kill("SIGKILL"), 5000).unref();
    });
  }
  rmSync(daemon.appDir, { recursive: true, force: true, maxRetries: 10 });
}

if (available) {
  defineSandboxContentSuites("Go daemon", startDaemon, stopDaemon);

  describe("the daemon sees protocol writes as working-tree writes", () => {
    test("a protocol write updates /_sandbox/decofile and announces it", async () => {
      const daemon = await startDaemon();
      try {
        seedSite(daemon.repoDir, { schema: true });
        const route = sandboxRoute(() => daemon);
        const before = await fetch(
          `http://localhost:${daemon.port}/_sandbox/decofile`,
        );
        await before.text();

        const events = new AbortController();
        const stream = await fetch(
          `http://localhost:${daemon.port}/_sandbox/events`,
          { signal: events.signal },
        );
        const reader = stream.body!.getReader();
        let seen = "";
        const announced = (async () => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) break;
            seen += new TextDecoder().decode(value);
            if (seen.includes(".deco/blocks/announce.json")) return true;
          }
          return false;
        })();
        await new Promise((r) => setTimeout(r, 300));

        const { error } = await rpc(route, "blocks.apply", {
          set: { announce: { title: "hi" } },
        });
        expect(error).toBeUndefined();
        expect(await announced).toBe(true);
        events.abort();

        const after = await fetch(
          `http://localhost:${daemon.port}/_sandbox/decofile`,
        );
        const merged = (await after.json()) as Record<string, unknown>;
        expect(merged.announce).toEqual({ title: "hi" });
        expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
      } finally {
        await stopDaemon(daemon);
      }
    }, 30_000);
  });
} else {
  test.skip("sandbox content protocol over the Go daemon (no daemon binary built)", () => {});
}

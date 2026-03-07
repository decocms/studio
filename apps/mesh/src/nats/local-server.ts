/**
 * Local NATS Server
 *
 * Automatically spawns a local nats-server when NATS_URL is not set.
 * Uses connect-first-then-spawn: the NATS port itself acts as the lock.
 * Multiple mesh instances share the same server.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect } from "nats";

const DEFAULT_PORT = 4222;
const CONNECT_TIMEOUT_MS = 1000;
const READY_TIMEOUT_MS = 5000;
const READY_POLL_MS = 100;

export interface LocalNatsServer {
  url: string;
  token: string | undefined;
  stop(): Promise<void>;
}

export async function ensureLocalNatsServer(
  dataDir = "./data",
  port = DEFAULT_PORT,
): Promise<LocalNatsServer> {
  const url = `nats://127.0.0.1:${port}`;
  const tokenFile = resolve(dataDir, "nats.token");

  // Try to connect to an existing server first (port acts as lock)
  const existingToken = readTokenFile(tokenFile);
  try {
    const nc = await connect({
      servers: url,
      timeout: CONNECT_TIMEOUT_MS,
      token: existingToken ?? undefined,
    });
    await nc.drain();
    console.log(`[NATS] Server already running on port ${port}, reusing`);
    return { url, token: existingToken ?? undefined, stop: async () => {} };
  } catch {
    // No server running, spawn one
  }

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Check if nats-server binary is available
  const natsServerPath = Bun.which("nats-server");
  if (!natsServerPath) {
    throw new Error(
      `[NATS] nats-server not found on PATH. Install it:\n` +
        `  macOS:  brew install nats-server\n` +
        `  Linux:  https://github.com/nats-io/nats-server/releases\n` +
        `Or set NATS_URL to point to an existing NATS server.`,
    );
  }

  // Generate auth token and write with restrictive permissions
  const token = crypto.randomUUID();
  writeFileSync(tokenFile, token, { mode: 0o600 });

  // Pipe stderr to log file
  const logPath = resolve(dataDir, "nats-server.log");
  const logFile = Bun.file(logPath);
  const pidFile = resolve(dataDir, "nats.pid");

  const proc = Bun.spawn(
    [
      natsServerPath,
      "-a",
      "127.0.0.1",
      "--port",
      String(port),
      "--jetstream",
      "--store_dir",
      resolve(dataDir, "nats-jetstream"),
      "--max_mem_store",
      "256MB",
      "--max_file_store",
      "512MB",
      "--auth",
      token,
      "--pid",
      pidFile,
    ],
    {
      stdio: ["ignore", "ignore", logFile],
    },
  );

  console.log(
    `[NATS] Spawning local nats-server (pid=${proc.pid}, port=${port})`,
  );

  // Poll with NATS connect until the server is ready
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    // Detect early crash (e.g., port conflict, bad config)
    if (proc.exitCode !== null) {
      const logContent = await Bun.file(logPath)
        .text()
        .catch(() => "(no log)");
      throw new Error(
        `[NATS] nats-server exited with code ${proc.exitCode} before becoming ready.\n` +
          `Server log:\n${logContent}`,
      );
    }

    try {
      const nc = await connect({
        servers: url,
        timeout: 500,
        token,
      });
      await nc.drain();
      console.log(`[NATS] Local server ready on ${url}`);
      return {
        url,
        token,
        async stop() {
          try {
            proc.kill();
            await proc.exited;
            console.log(`[NATS] Stopped local nats-server (pid=${proc.pid})`);
          } catch {
            // Process already dead
          }
        },
      };
    } catch {
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }

  // Timed out — kill the process and report error with log content
  proc.kill();
  await proc.exited;
  const logContent = await Bun.file(logPath)
    .text()
    .catch(() => "(no log)");
  throw new Error(
    `[NATS] Local server did not become ready on port ${port} within ${READY_TIMEOUT_MS}ms.\n` +
      `Server log:\n${logContent}`,
  );
}

function readTokenFile(path: string): string | null {
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

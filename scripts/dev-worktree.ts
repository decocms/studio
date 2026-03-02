#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CADDY_ADMIN = "http://localhost:2019";
const MAP_DIR = join(homedir(), ".studio-worktrees");
const MAP_FILE = join(MAP_DIR, "proxy-map.json");
const CADDY_SERVER_ID = "studio-worktrees";

interface WorktreeEntry {
  port: number;
  vitePort: number;
  pid: number;
}

type ProxyMap = Record<string, WorktreeEntry>;

function readMap(): ProxyMap {
  if (!existsSync(MAP_FILE)) return {};
  try {
    return JSON.parse(readFileSync(MAP_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeMap(map: ProxyMap): void {
  if (!existsSync(MAP_DIR)) mkdirSync(MAP_DIR, { recursive: true });
  writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findFreePort(
  start: number,
  usedPorts: Set<number>,
): Promise<number> {
  for (let port = start; port < start + 1000; port++) {
    if (usedPorts.has(port)) continue;
    try {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          open() {},
          data() {},
          close() {},
          error() {},
        },
      });
      server.stop();
      return port;
    } catch {
      // port in use, try next
    }
  }
  throw new Error(`No free port found starting from ${start}`);
}

async function assertCaddyRunning(): Promise<void> {
  try {
    const res = await fetch(`${CADDY_ADMIN}/config/`);
    if (!res.ok) throw new Error();
  } catch {
    console.error(`
❌ Caddy is not running. One-time setup required:

  brew install caddy
  brew services start caddy

Then re-run dev:worktree.
`);
    process.exit(1);
  }
}

async function ensureCaddyServer(): Promise<void> {
  const res = await fetch(
    `${CADDY_ADMIN}/config/apps/http/servers/${CADDY_SERVER_ID}`,
  );
  if (res.ok) return;

  // Intermediate paths may not exist yet (fresh Caddy with empty config).
  // Use /load to merge our server into the top-level config safely.
  const currentRes = await fetch(`${CADDY_ADMIN}/config/`);
  const current = (currentRes.ok ? await currentRes.json() : null) ?? {};

  const merged = {
    ...current,
    apps: {
      ...(current.apps ?? {}),
      http: {
        ...(current.apps?.http ?? {}),
        servers: {
          ...(current.apps?.http?.servers ?? {}),
          [CADDY_SERVER_ID]: { listen: [":80"], routes: [] },
        },
      },
    },
  };

  const loadRes = await fetch(`${CADDY_ADMIN}/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(merged),
  });

  if (!loadRes.ok) {
    const text = await loadRes.text();
    throw new Error(`Failed to bootstrap Caddy server: ${text}`);
  }

  console.log(`✓ Bootstrapped Caddy server '${CADDY_SERVER_ID}' on :80`);
}

async function registerRoute(slug: string, port: number): Promise<void> {
  const route = {
    "@id": `worktree-${slug}`,
    match: [{ host: [`${slug}.localhost`] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `localhost:${port}` }],
      },
    ],
  };

  const res = await fetch(
    `${CADDY_ADMIN}/config/apps/http/servers/${CADDY_SERVER_ID}/routes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to register Caddy route: ${text}`);
  }
}

async function removeRoute(slug: string): Promise<void> {
  await fetch(`${CADDY_ADMIN}/id/worktree-${slug}`, { method: "DELETE" });
}

async function run(slug: string): Promise<void> {
  // Clean stale entries and collect used ports
  const map = readMap();
  const usedPorts = new Set<number>();

  for (const [key, entry] of Object.entries(map)) {
    if (isProcessAlive(entry.pid)) {
      usedPorts.add(entry.port);
      usedPorts.add(entry.vitePort);
    } else {
      console.log(`🧹 Cleaned stale entry for '${key}'`);
      delete map[key];
    }
  }

  const port = await findFreePort(3000, usedPorts);
  usedPorts.add(port);
  const vitePort = await findFreePort(4000, usedPorts);

  console.log(`🔌 ${slug}.localhost → Hono :${port}, Vite :${vitePort}`);

  await assertCaddyRunning();
  await ensureCaddyServer();
  await registerRoute(slug, port);

  map[slug] = { port, vitePort, pid: process.pid };
  writeMap(map);

  console.log(`✅ http://${slug}.localhost is live`);

  // Resolve repo root: scripts/ lives one level below the root
  const repoRoot = join(import.meta.dir, "..");

  const child = Bun.spawn(
    ["bun", "run", "--env-file=.env", "--cwd=apps/mesh", "dev"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        VITE_PORT: String(vitePort),
      },
      stdio: ["inherit", "inherit", "inherit"],
    },
  );

  async function cleanup(): Promise<void> {
    console.log(`\n🧹 Cleaning up ${slug}...`);
    try {
      await removeRoute(slug);
    } catch (e) {
      console.warn("Warning: failed to remove Caddy route:", e);
    }
    const current = readMap();
    delete current[slug];
    writeMap(current);
    child.kill();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await child.exited;
  await cleanup();
}

const slug = process.env.WORKTREE_SLUG;
if (!slug) {
  console.error("❌ WORKTREE_SLUG environment variable is required.");
  process.exit(1);
}

run(slug).catch((e) => {
  console.error("dev:worktree error:", e);
  process.exit(1);
});

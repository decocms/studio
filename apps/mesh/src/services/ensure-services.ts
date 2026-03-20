/**
 * Service management for local development.
 * Ensures PostgreSQL and NATS are running before the app starts.
 *
 * Used by both `cli.ts` (npx decocms) and `scripts/dev.ts` (bun run dev).
 *
 * Each `home` directory gets its own `services/` tree with state.json files
 * for service discovery. Multiple projects can run concurrently with isolated
 * databases and NATS instances on different dynamic ports.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { chmod, unlink } from "fs/promises";
import { createRequire } from "module";
import { createConnection, createServer } from "net";
import { arch, platform } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PG_USER = "postgres";
const PG_PASSWORD = "postgres";
const PG_DATABASE = "postgres";

const NATS_VERSION = "v2.10.24";

const IS_WINDOWS = platform() === "win32";
const EXE_EXT = IS_WINDOWS ? ".exe" : "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceState = "running" | "external" | "stopped";

interface ServiceInfo {
  name: string;
  state: ServiceState;
  pid: number | null;
  port: number;
  owner: "managed" | "external" | "none";
}

interface StateFile {
  pid: number;
  port: number;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function servicesDir(home: string): string {
  return join(home, "services");
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not determine port")));
      }
    });
    srv.on("error", reject);
  });
}

function stateFilePath(home: string, service: string): string {
  return join(servicesDir(home), service, "state.json");
}

function readState(home: string, service: string): StateFile | null {
  const p = stateFilePath(home, service);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as StateFile;
    }
    return null;
  } catch {
    return null;
  }
}

function writeState(home: string, service: string, state: StateFile) {
  const dir = join(servicesDir(home), service);
  ensureDir(dir);
  writeFileSync(stateFilePath(home, service), JSON.stringify(state, null, 2));
}

async function removeState(home: string, service: string) {
  const p = stateFilePath(home, service);
  if (existsSync(p)) await unlink(p);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that a PID belongs to the expected service by checking the process
 * command line. This guards against PID reuse: if the OS recycled the PID for
 * an unrelated process, we must not signal it.
 */
function isOwnedProcess(pid: number, expectedName: string): boolean {
  if (!isProcessAlive(pid)) return false;

  try {
    if (IS_WINDOWS) {
      const proc = Bun.spawnSync([
        "wmic",
        "process",
        "where",
        `ProcessId=${pid}`,
        "get",
        "CommandLine",
      ]);
      const output = new TextDecoder().decode(proc.stdout);
      return output.toLowerCase().includes(expectedName.toLowerCase());
    }

    // Unix: read /proc or use ps
    const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="]);
    const output = new TextDecoder().decode(proc.stdout).trim().toLowerCase();
    return output.includes(expectedName.toLowerCase());
  } catch {
    // If we can't verify, assume it's ours to avoid breaking existing behavior
    return true;
  }
}

function probePort(port: number, host = "localhost"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port)) return;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

// ---------------------------------------------------------------------------
// PostgreSQL (via embedded-postgres)
// ---------------------------------------------------------------------------

/**
 * Fix missing .dylib symlinks in the embedded-postgres platform package.
 *
 * The npm package ships a `pg-symlinks.json` manifest listing symlinks that
 * must exist (e.g. libicudata.77.1.dylib → libicudata.77.dylib). These are
 * created by a postinstall script, but bun doesn't always run postinstall for
 * optional platform packages, so we re-hydrate them at startup.
 *
 * We locate the platform package by using createRequire scoped to the
 * embedded-postgres module, which can resolve its optional dependencies
 * regardless of directory layout (.bun cache, flat node_modules, or bunx).
 */
function fixEmbeddedPostgresLibSymlinks() {
  try {
    // Resolve the platform-specific package from embedded-postgres's own
    // module context using createRequire. This works regardless of directory
    // layout (.bun cache, flat node_modules, bunx temporary installs).
    const epPath = require.resolve("embedded-postgres");
    const requireFromEp = createRequire(epPath);
    const platformPkgName = `@embedded-postgres/${platform()}-${arch()}`;
    const resolved = requireFromEp.resolve(platformPkgName);

    // resolved = <pkgRoot>/dist/index.js — navigate up to package root
    const pkgRoot = join(dirname(resolved), "..");
    const symlinksFile = join(pkgRoot, "native", "pg-symlinks.json");

    if (!existsSync(symlinksFile)) return;

    const symlinks: { source: string; target: string }[] = JSON.parse(
      readFileSync(symlinksFile, "utf-8"),
    );

    for (const { source, target } of symlinks) {
      const absTarget = join(pkgRoot, target);
      if (existsSync(absTarget)) continue;

      const targetDir = join(absTarget, "..");
      const sourceName = source.split("/").pop()!;
      const targetName = target.split("/").pop()!;
      const cwd = process.cwd();
      try {
        process.chdir(targetDir);
        symlinkSync(sourceName, targetName);
      } catch {
        // Symlink may already exist from a concurrent run
      } finally {
        process.chdir(cwd);
      }
    }
  } catch {
    // Package not found — skip
  }
}

function pgConnectionString(port: number): string {
  return `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${port}/${PG_DATABASE}`;
}

async function ensurePostgres(home: string): Promise<ServiceInfo> {
  const info: ServiceInfo = {
    name: "PostgreSQL",
    state: "stopped",
    pid: null,
    port: 0,
    owner: "none",
  };

  // Check state.json for an existing managed instance
  const existing = readState(home, "postgres");
  if (existing !== null) {
    if (isOwnedProcess(existing.pid, "postgres")) {
      info.state = "running";
      info.pid = existing.pid;
      info.port = existing.port;
      info.owner = "managed";
      return info;
    }
    // Dead process — clean up stale state
    await removeState(home, "postgres");
  }

  const dataDir = join(servicesDir(home), "postgres", "data");
  ensureDir(dataDir);

  // Check for an already-running postgres via postmaster.pid (handles migration
  // from the old PID-file system and concurrent instances sharing the data dir)
  const postmasterPidFile = join(dataDir, "postmaster.pid");
  if (existsSync(postmasterPidFile)) {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const existingPid = lines[0]?.trim()
      ? Number.parseInt(lines[0].trim(), 10)
      : null;
    const existingPort = lines[3]?.trim()
      ? Number.parseInt(lines[3].trim(), 10)
      : null;

    if (
      existingPid &&
      existingPort &&
      isOwnedProcess(existingPid, "postgres")
    ) {
      writeState(home, "postgres", {
        pid: existingPid,
        port: existingPort,
        startedAt: new Date().toISOString(),
      });
      info.state = "running";
      info.pid = existingPid;
      info.port = existingPort;
      info.owner = "managed";
      return info;
    }
  }

  // Allocate a dynamic port
  const port = await findAvailablePort();
  info.port = port;

  const EmbeddedPostgres = (await import("embedded-postgres")).default;
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: PG_USER,
    password: PG_PASSWORD,
    persistent: true,
    onLog: (msg: string) => {
      if (process.env.DEBUG_SERVICES) console.log(`[pg] ${msg}`);
    },
  });

  // Fix missing .dylib symlinks before any postgres operation
  fixEmbeddedPostgresLibSymlinks();

  const pgVersionFile = join(dataDir, "PG_VERSION");
  if (!existsSync(pgVersionFile)) {
    try {
      await pg.initialise();
    } catch (initErr) {
      // initdb may have been killed by a signal (exit code null) due to a race
      // with another process initializing the same data directory. Log the
      // error for debugging — do NOT remove the data dir as it may contain
      // important data from a prior run.
      console.error(
        `[ensurePostgres] pg.initialise() failed. dataDir=${dataDir}`,
        initErr,
      );

      // Another process (e.g. another workspace) may have won the race and
      // already started postgres — check state again
      const raceState = readState(home, "postgres");
      if (raceState && isOwnedProcess(raceState.pid, "postgres")) {
        info.state = "running";
        info.pid = raceState.pid;
        info.port = raceState.port;
        info.owner = "managed";
        return info;
      }

      throw initErr;
    }
  }
  await pg.start();

  try {
    await pg.createDatabase(PG_DATABASE);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("already exists")) throw e;
  }

  await waitForPort(port);

  let pgPid: number | null = null;
  if (existsSync(postmasterPidFile)) {
    const firstLine = readFileSync(postmasterPidFile, "utf8")
      .split("\n")[0]
      ?.trim();
    if (firstLine) pgPid = Number.parseInt(firstLine, 10);
  }

  if (pgPid) {
    writeState(home, "postgres", {
      pid: pgPid,
      port,
      startedAt: new Date().toISOString(),
    });
    info.pid = pgPid;
  }

  info.state = "running";
  info.owner = "managed";
  return info;
}

async function stopPostgres(home: string): Promise<void> {
  const state = readState(home, "postgres");
  if (state === null) {
    console.log("PostgreSQL: not running");
    return;
  }

  const { pid, port } = state;

  if (!isProcessAlive(pid)) {
    console.log("PostgreSQL: process already dead, cleaning up state");
    await removeState(home, "postgres");
    return;
  }

  if (!isOwnedProcess(pid, "postgres")) {
    console.log(
      `PostgreSQL: PID ${pid} no longer belongs to postgres (possible PID reuse), cleaning up state`,
    );
    await removeState(home, "postgres");
    return;
  }

  console.log(`PostgreSQL: stopping (PID ${pid}, port ${port})...`);

  const dataDir = join(servicesDir(home), "postgres", "data");
  try {
    const EmbeddedPostgres = (await import("embedded-postgres")).default;
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      port,
      user: PG_USER,
      password: PG_PASSWORD,
      persistent: true,
    });
    await pg.stop();
  } catch {
    console.log(
      "PostgreSQL: embedded-postgres stop failed, sending SIGTERM...",
    );
    try {
      if (!isOwnedProcess(pid, "postgres")) {
        console.log(
          `PostgreSQL: PID ${pid} is no longer postgres, skipping signal`,
        );
      } else {
        process.kill(pid, "SIGTERM");
        const start = Date.now();
        while (Date.now() - start < 5000 && isProcessAlive(pid)) {
          await Bun.sleep(200);
        }
        if (isProcessAlive(pid) && isOwnedProcess(pid, "postgres")) {
          process.kill(pid, "SIGKILL");
        }
      }
    } catch {
      // Process may already be dead
    }
  }

  await removeState(home, "postgres");
  console.log("PostgreSQL stopped");
}

// ---------------------------------------------------------------------------
// NATS (auto-downloaded binary)
// ---------------------------------------------------------------------------

function natsArtifactName(): string {
  const p = platform();
  const a = arch();

  const osMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };

  const archMap: Record<string, string> = {
    arm64: "arm64",
    x64: "amd64",
  };

  const osName = osMap[p];
  const archName = archMap[a];

  if (!osName || !archName) {
    throw new Error(`Unsupported platform: ${p}/${a}`);
  }

  return `nats-server-${NATS_VERSION}-${osName}-${archName}.zip`;
}

function natsBinaryPath(home: string): string {
  return join(servicesDir(home), "nats", "bin", `nats-server${EXE_EXT}`);
}

async function downloadNats(home: string): Promise<string> {
  const binPath = natsBinaryPath(home);
  if (existsSync(binPath)) return binPath;

  const binDir = join(servicesDir(home), "nats", "bin");
  ensureDir(binDir);

  const artifact = natsArtifactName();
  const url = `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/${artifact}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download NATS: ${response.status} ${response.statusText}`,
    );
  }

  const zipPath = join(binDir, artifact);
  const arrayBuffer = await response.arrayBuffer();
  writeFileSync(zipPath, Buffer.from(arrayBuffer));

  if (IS_WINDOWS) {
    const proc = Bun.spawn([
      "powershell",
      "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${binDir}' -Force`,
    ]);
    await proc.exited;
  } else {
    const proc = Bun.spawn([
      "unzip",
      "-o",
      "-j",
      zipPath,
      "*/nats-server",
      "-d",
      binDir,
    ]);
    await proc.exited;
  }

  await unlink(zipPath);

  if (!IS_WINDOWS) {
    await chmod(binPath, 0o755);
  }

  if (!existsSync(binPath)) {
    throw new Error(`NATS binary not found at ${binPath} after extraction`);
  }

  return binPath;
}

async function ensureNats(home: string): Promise<ServiceInfo> {
  const info: ServiceInfo = {
    name: "NATS",
    state: "stopped",
    pid: null,
    port: 0,
    owner: "none",
  };

  // Check state.json for an existing managed instance
  const existing = readState(home, "nats");
  if (existing !== null) {
    if (isOwnedProcess(existing.pid, "nats-server")) {
      info.state = "running";
      info.pid = existing.pid;
      info.port = existing.port;
      info.owner = "managed";
      return info;
    }
    // Dead process — clean up stale state
    await removeState(home, "nats");
  }

  // Allocate a dynamic port
  const port = await findAvailablePort();
  info.port = port;

  const binPath = await downloadNats(home);
  const dataDir = join(servicesDir(home), "nats", "data");
  const logDir = join(servicesDir(home), "nats");
  ensureDir(dataDir);

  const logFile = Bun.file(join(logDir, "nats.log"));
  const proc = Bun.spawn(
    [binPath, "-p", String(port), "-store_dir", dataDir, "--jetstream"],
    {
      stdout: logFile,
      stderr: logFile,
    },
  );

  writeState(home, "nats", {
    pid: proc.pid,
    port,
    startedAt: new Date().toISOString(),
  });

  await waitForPort(port);

  info.state = "running";
  info.pid = proc.pid;
  info.owner = "managed";
  return info;
}

async function stopNats(home: string): Promise<void> {
  const state = readState(home, "nats");
  if (state === null) {
    console.log("NATS: not running");
    return;
  }

  const { pid } = state;

  if (!isProcessAlive(pid)) {
    console.log("NATS: process already dead, cleaning up state");
    await removeState(home, "nats");
    return;
  }

  if (!isOwnedProcess(pid, "nats-server")) {
    console.log(
      `NATS: PID ${pid} no longer belongs to nats-server (possible PID reuse), cleaning up state`,
    );
    await removeState(home, "nats");
    return;
  }

  console.log(`NATS: stopping (PID ${pid})...`);

  if (IS_WINDOWS) {
    Bun.spawn(["taskkill", "/PID", String(pid)]);
  } else {
    process.kill(pid, "SIGTERM");
  }

  const start = Date.now();
  while (Date.now() - start < 5000 && isProcessAlive(pid)) {
    await Bun.sleep(200);
  }

  if (isProcessAlive(pid) && isOwnedProcess(pid, "nats-server")) {
    console.log("NATS: force killing...");
    if (IS_WINDOWS) {
      Bun.spawn(["taskkill", "/PID", String(pid), "/F"]);
    } else {
      process.kill(pid, "SIGKILL");
    }
  }

  await removeState(home, "nats");
  console.log("NATS stopped");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return true; // If we can't parse it, assume local (safe fallback)
  }
}

function portFromUrl(url: string, fallback: number): number {
  try {
    const parsed = new URL(url);
    return parsed.port ? Number.parseInt(parsed.port, 10) : fallback;
  } catch {
    return fallback;
  }
}

export async function ensureServices(home: string): Promise<ServiceInfo[]> {
  ensureDir(servicesDir(home));

  const skipPostgres =
    process.env.DATABASE_URL && !isLocalUrl(process.env.DATABASE_URL);
  const skipNats = process.env.NATS_URL && !isLocalUrl(process.env.NATS_URL);

  const pgInfo: ServiceInfo = skipPostgres
    ? {
        name: "PostgreSQL",
        state: "external",
        pid: null,
        port: portFromUrl(process.env.DATABASE_URL!, 5432),
        owner: "external",
      }
    : await ensurePostgres(home);

  const natsInfo: ServiceInfo = skipNats
    ? {
        name: "NATS",
        state: "external",
        pid: null,
        port: portFromUrl(process.env.NATS_URL!, 4222),
        owner: "external",
      }
    : await ensureNats(home);

  if (!skipPostgres && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = pgConnectionString(pgInfo.port);
  }

  if (!skipNats && !process.env.NATS_URL) {
    process.env.NATS_URL = `nats://localhost:${natsInfo.port}`;
  }

  return [pgInfo, natsInfo];
}

export async function stopServices(home: string): Promise<void> {
  await stopPostgres(home);
  await stopNats(home);
  console.log("\nAll managed services stopped.");
}

async function serviceStatus(home: string): Promise<ServiceInfo[]> {
  const services: ServiceInfo[] = [];

  const pgState = readState(home, "postgres");
  if (pgState !== null && isProcessAlive(pgState.pid)) {
    services.push({
      name: "PostgreSQL",
      state: "running",
      pid: pgState.pid,
      port: pgState.port,
      owner: "managed",
    });
  } else {
    if (pgState !== null) await removeState(home, "postgres");
    services.push({
      name: "PostgreSQL",
      state: "stopped",
      pid: null,
      port: 0,
      owner: "none",
    });
  }

  const natsState = readState(home, "nats");
  if (natsState !== null && isProcessAlive(natsState.pid)) {
    services.push({
      name: "NATS",
      state: "running",
      pid: natsState.pid,
      port: natsState.port,
      owner: "managed",
    });
  } else {
    if (natsState !== null) await removeState(home, "nats");
    services.push({
      name: "NATS",
      state: "stopped",
      pid: null,
      port: 0,
      owner: "none",
    });
  }

  return services;
}

export function printTable(services: ServiceInfo[]) {
  const header = "Service     State       PID    Port   Owner";
  const sep = "----------  ----------  -----  -----  ----------";
  console.log(header);
  console.log(sep);
  for (const s of services) {
    const name = s.name.padEnd(10);
    const state = s.state.padEnd(10);
    const pid = (s.pid?.toString() ?? "-").padEnd(5);
    const port = (s.port ? String(s.port) : "-").padEnd(5);
    const owner = s.owner;
    console.log(`${name}  ${state}  ${pid}  ${port}  ${owner}`);
  }
}

export { serviceStatus as getStatus };
export type { ServiceInfo };

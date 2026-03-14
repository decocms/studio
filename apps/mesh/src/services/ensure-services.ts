/**
 * Service management for local development.
 * Ensures PostgreSQL and NATS are running before the app starts.
 *
 * Used by both `cli.ts` (npx decocms) and `scripts/dev.ts` (bun run dev).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { chmod, unlink } from "fs/promises";
import { createConnection } from "net";
import { arch, homedir, platform } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICES_DIR = join(homedir(), ".deco", "services");

const PG_PORT = 5432;
const PG_USER = "deco";
const PG_PASSWORD = "deco";
const PG_DATABASE = "deco_dev";
const PG_CONNECTION_STRING = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DATABASE}`;

const NATS_PORT = 4222;
const NATS_VERSION = "v2.10.24";
const NATS_CONNECTION_STRING = `nats://localhost:${NATS_PORT}`;

const IS_WINDOWS = platform() === "win32";
const EXE_EXT = IS_WINDOWS ? ".exe" : "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function pidFilePath(service: string): string {
  return join(SERVICES_DIR, service, "pid");
}

function readPid(service: string): number | null {
  const p = pidFilePath(service);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
}

function writePid(service: string, pid: number) {
  const dir = join(SERVICES_DIR, service);
  ensureDir(dir);
  writeFileSync(pidFilePath(service), String(pid));
}

async function removePid(service: string) {
  const p = pidFilePath(service);
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

type ServiceState = "running" | "external" | "stopped";

interface ServiceInfo {
  name: string;
  state: ServiceState;
  pid: number | null;
  port: number;
  owner: "managed" | "external" | "none";
}

// ---------------------------------------------------------------------------
// PostgreSQL (via embedded-postgres)
// ---------------------------------------------------------------------------

async function ensurePostgres(): Promise<ServiceInfo> {
  const info: ServiceInfo = {
    name: "PostgreSQL",
    state: "stopped",
    pid: null,
    port: PG_PORT,
    owner: "none",
  };

  const existingPid = readPid("postgres");
  if (existingPid !== null) {
    if (isProcessAlive(existingPid)) {
      info.state = "running";
      info.pid = existingPid;
      info.owner = "managed";
      console.log(`PostgreSQL already running (PID ${existingPid})`);
      return info;
    }
    console.log("PostgreSQL: stale PID file, cleaning up...");
    await removePid("postgres");
  }

  if (await probePort(PG_PORT)) {
    console.log(
      `PostgreSQL: port ${PG_PORT} already in use — reusing external instance`,
    );
    info.state = "external";
    info.owner = "external";
    return info;
  }

  console.log("PostgreSQL: starting via embedded-postgres...");
  const dataDir = join(SERVICES_DIR, "postgres", "data");
  ensureDir(dataDir);

  const EmbeddedPostgres = (await import("embedded-postgres")).default;
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    persistent: true,
    onLog: (msg: string) => {
      if (process.env.DEBUG_SERVICES) console.log(`[pg] ${msg}`);
    },
  });

  await pg.initialise();
  await pg.start();

  try {
    await pg.createDatabase(PG_DATABASE);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("already exists")) throw e;
  }

  await waitForPort(PG_PORT);

  const postmasterPidFile = join(dataDir, "postmaster.pid");
  let pgPid: number | null = null;
  if (existsSync(postmasterPidFile)) {
    const firstLine = readFileSync(postmasterPidFile, "utf8")
      .split("\n")[0]
      ?.trim();
    if (firstLine) pgPid = Number.parseInt(firstLine, 10);
  }

  if (pgPid) {
    writePid("postgres", pgPid);
    info.pid = pgPid;
  }

  info.state = "running";
  info.owner = "managed";
  console.log(
    `PostgreSQL started on port ${PG_PORT} (PID ${pgPid ?? "unknown"})`,
  );
  return info;
}

async function stopPostgres(): Promise<void> {
  const pid = readPid("postgres");
  if (pid === null) {
    if (await probePort(PG_PORT)) {
      console.log("PostgreSQL: running externally, skipping stop");
    } else {
      console.log("PostgreSQL: not running");
    }
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log("PostgreSQL: process already dead, cleaning up PID file");
    await removePid("postgres");
    return;
  }

  console.log(`PostgreSQL: stopping (PID ${pid})...`);

  const dataDir = join(SERVICES_DIR, "postgres", "data");
  try {
    const EmbeddedPostgres = (await import("embedded-postgres")).default;
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      port: PG_PORT,
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
      process.kill(pid, "SIGTERM");
      const start = Date.now();
      while (Date.now() - start < 5000 && isProcessAlive(pid)) {
        await Bun.sleep(200);
      }
      if (isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Process may already be dead
    }
  }

  await removePid("postgres");
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

function natsBinaryPath(): string {
  return join(SERVICES_DIR, "nats", "bin", `nats-server${EXE_EXT}`);
}

async function downloadNats(): Promise<string> {
  const binPath = natsBinaryPath();
  if (existsSync(binPath)) return binPath;

  const binDir = join(SERVICES_DIR, "nats", "bin");
  ensureDir(binDir);

  const artifact = natsArtifactName();
  const url = `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/${artifact}`;

  console.log(`NATS: downloading ${artifact}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download NATS: ${response.status} ${response.statusText}`,
    );
  }

  const zipPath = join(binDir, artifact);
  const arrayBuffer = await response.arrayBuffer();
  writeFileSync(zipPath, Buffer.from(arrayBuffer));

  console.log("NATS: extracting...");
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

  console.log(`NATS: binary installed at ${binPath}`);
  return binPath;
}

async function ensureNats(): Promise<ServiceInfo> {
  const info: ServiceInfo = {
    name: "NATS",
    state: "stopped",
    pid: null,
    port: NATS_PORT,
    owner: "none",
  };

  const existingPid = readPid("nats");
  if (existingPid !== null) {
    if (isProcessAlive(existingPid)) {
      info.state = "running";
      info.pid = existingPid;
      info.owner = "managed";
      console.log(`NATS already running (PID ${existingPid})`);
      return info;
    }
    console.log("NATS: stale PID file, cleaning up...");
    await removePid("nats");
  }

  if (await probePort(NATS_PORT)) {
    console.log(
      `NATS: port ${NATS_PORT} already in use — reusing external instance`,
    );
    info.state = "external";
    info.owner = "external";
    return info;
  }

  const binPath = await downloadNats();
  const dataDir = join(SERVICES_DIR, "nats", "data");
  const logDir = join(SERVICES_DIR, "nats");
  ensureDir(dataDir);

  console.log("NATS: starting...");
  const logFile = Bun.file(join(logDir, "nats.log"));
  const proc = Bun.spawn(
    [binPath, "-p", String(NATS_PORT), "-store_dir", dataDir, "--jetstream"],
    {
      stdout: logFile,
      stderr: logFile,
    },
  );

  writePid("nats", proc.pid);

  await waitForPort(NATS_PORT);

  info.state = "running";
  info.pid = proc.pid;
  info.owner = "managed";
  console.log(`NATS started on port ${NATS_PORT} (PID ${proc.pid})`);
  return info;
}

async function stopNats(): Promise<void> {
  const pid = readPid("nats");
  if (pid === null) {
    if (await probePort(NATS_PORT)) {
      console.log("NATS: running externally, skipping stop");
    } else {
      console.log("NATS: not running");
    }
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log("NATS: process already dead, cleaning up PID file");
    await removePid("nats");
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

  if (isProcessAlive(pid)) {
    console.log("NATS: force killing...");
    if (IS_WINDOWS) {
      Bun.spawn(["taskkill", "/PID", String(pid), "/F"]);
    } else {
      process.kill(pid, "SIGKILL");
    }
  }

  await removePid("nats");
  console.log("NATS stopped");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ensureServices(): Promise<void> {
  ensureDir(SERVICES_DIR);

  const [pgInfo, natsInfo] = await Promise.all([
    ensurePostgres(),
    ensureNats(),
  ]);

  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = PG_CONNECTION_STRING;
    console.log(`DATABASE_URL set to ${PG_CONNECTION_STRING}`);
  }

  if (!process.env.NATS_URL) {
    process.env.NATS_URL = NATS_CONNECTION_STRING;
    console.log(`NATS_URL set to ${NATS_CONNECTION_STRING}`);
  }

  console.log("\nServices ready:");
  printTable([pgInfo, natsInfo]);
}

export async function stopServices(): Promise<void> {
  await stopPostgres();
  await stopNats();
  console.log("\nAll managed services stopped.");
}

export async function serviceStatus(): Promise<ServiceInfo[]> {
  const services: ServiceInfo[] = [];

  const pgPid = readPid("postgres");
  if (pgPid !== null && isProcessAlive(pgPid)) {
    services.push({
      name: "PostgreSQL",
      state: "running",
      pid: pgPid,
      port: PG_PORT,
      owner: "managed",
    });
  } else if (await probePort(PG_PORT)) {
    services.push({
      name: "PostgreSQL",
      state: "external",
      pid: null,
      port: PG_PORT,
      owner: "external",
    });
  } else {
    services.push({
      name: "PostgreSQL",
      state: "stopped",
      pid: null,
      port: PG_PORT,
      owner: "none",
    });
  }

  const natsPid = readPid("nats");
  if (natsPid !== null && isProcessAlive(natsPid)) {
    services.push({
      name: "NATS",
      state: "running",
      pid: natsPid,
      port: NATS_PORT,
      owner: "managed",
    });
  } else if (await probePort(NATS_PORT)) {
    services.push({
      name: "NATS",
      state: "external",
      pid: null,
      port: NATS_PORT,
      owner: "external",
    });
  } else {
    services.push({
      name: "NATS",
      state: "stopped",
      pid: null,
      port: NATS_PORT,
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
    const port = String(s.port).padEnd(5);
    const owner = s.owner;
    console.log(`${name}  ${state}  ${pid}  ${port}  ${owner}`);
  }
}

export { serviceStatus as getStatus };
export type { ServiceInfo };

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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { retry, sleep } from "@decocms/shared/std";
import { chmod, unlink } from "fs/promises";
import { createRequire } from "module";
import { createConnection, createServer } from "net";
import { arch, platform } from "os";
import { dirname, join } from "path";
import type { ServiceInputs, ServiceOutputs } from "../settings/types";
import { resolveS3ForcePathStyle } from "../settings/resolve-config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PG_USER = "postgres";
const PG_PASSWORD = "postgres";
const PG_DATABASE = "postgres";

const NATS_VERSION = "v2.14.2";

// MinIO dev defaults. The root credentials mirror the e2e setup
// (.github/actions/start-minio) so local dev and CI use the same contract.
const MINIO_ROOT_USER = "minioadmin";
const MINIO_ROOT_PASSWORD = "minioadmin";
const MINIO_DEV_BUCKET = "studio-dev";
const MINIO_DEFAULT_PORT = 9000;

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
  /**
   * Legacy operator-mode NATS state. Its presence forces a one-time restart
   * into the current loopback-only JetStream configuration.
   */
  wsPort?: number;
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
 *
 * The managed services are launched as their own binaries, so matching the
 * executable name (`ps -o comm=`) is sufficient.
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

    const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="]);
    const output = new TextDecoder().decode(proc.stdout).trim().toLowerCase();
    return output.includes(expectedName.toLowerCase());
  } catch {
    // If we can't verify, assume it's ours to avoid breaking existing behavior
    return true;
  }
}

function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
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

async function waitForPort(
  port: number,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error(`Aborted waiting for port ${port}`);
    if (await probePort(port)) return;
    await sleep(200, signal ? { signal } : undefined).catch(() => {});
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
    let pidFileContent: string | null = null;
    try {
      pidFileContent = readFileSync(postmasterPidFile, "utf8");
    } catch {
      // File was deleted between existsSync and readFileSync (concurrent run)
    }
    if (pidFileContent !== null) {
      const lines = pidFileContent.split("\n");
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
        // Do not write state for a pid-file discovered instance — we have no
        // provenance to confirm we started it, so we treat it as external.
        // Writing to state.json would allow stopPostgres to terminate an
        // instance we do not own.
        info.state = "external";
        info.pid = existingPid;
        info.port = existingPort;
        info.owner = "external";
        return info;
      }
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
      const errMsg =
        initErr instanceof Error ? initErr.message : String(initErr);

      // Detect missing locale — embedded-postgres requires en_US.UTF-8 which
      // is not available on minimal Linux installations (e.g. Ubuntu minimal,
      // Alpine, slim Docker images).
      if (
        errMsg.includes("init script exited with code 1") ||
        errMsg.includes("invalid locale")
      ) {
        console.error(
          `[ensurePostgres] PostgreSQL initialisation failed. This is likely caused by a missing locale.\n` +
            `  embedded-postgres requires the "en_US.UTF-8" locale, which may not be installed on all Linux systems.\n` +
            `  To fix, run:\n` +
            `    sudo apt-get install -y locales && sudo locale-gen en_US.UTF-8\n` +
            `  Then retry.`,
        );
      }

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
          await sleep(200);
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

  // NATS dropped the `.zip` artifacts for darwin/linux after the 2.10 line;
  // unix releases ship only `.tar.gz` (zip remains Windows-only).
  const ext = osName === "windows" ? "zip" : "tar.gz";
  return `nats-server-${NATS_VERSION}-${osName}-${archName}.${ext}`;
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

  const archivePath = join(binDir, artifact);
  const arrayBuffer = await response.arrayBuffer();
  writeFileSync(archivePath, Buffer.from(arrayBuffer));

  // Both the Windows `.zip` and the unix `.tar.gz` contain a single versioned
  // top-level directory (e.g. nats-server-v2.14.2-linux-amd64/nats-server).
  // Extract the whole archive, then move the binary up to binDir and drop the
  // versioned directory so binPath resolves regardless of platform packaging.
  const extractedDir = join(binDir, artifact.replace(/\.(zip|tar\.gz)$/, ""));

  if (IS_WINDOWS) {
    const proc = Bun.spawn([
      "powershell",
      "-Command",
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force`,
    ]);
    await proc.exited;
  } else {
    // `tar` (with gzip via -z) is universally present on macOS/Linux, unlike
    // `unzip`. Unix releases ship only `.tar.gz` since the 2.11 line.
    const proc = Bun.spawn(["tar", "-xzf", archivePath, "-C", binDir]);
    await proc.exited;
  }

  if (!existsSync(binPath)) {
    const extractedBin = join(extractedDir, `nats-server${EXE_EXT}`);
    if (existsSync(extractedBin)) {
      renameSync(extractedBin, binPath);
    }
  }
  rmSync(extractedDir, { recursive: true, force: true });

  await unlink(archivePath).catch(() => {});

  if (!IS_WINDOWS) {
    await chmod(binPath, 0o755);
  }

  if (!existsSync(binPath)) {
    throw new Error(`NATS binary not found at ${binPath} after extraction`);
  }

  return binPath;
}

/**
 * Build the managed NATS command. The explicit loopback bind is a security
 * boundary: local development must not expose an unauthenticated NATS server
 * to the LAN. JetStream data stays under the selected Studio home directory.
 */
export function managedNatsCommand(
  binPath: string,
  port: number,
  storeDir: string,
): string[] {
  return [
    binPath,
    "-js",
    "-a",
    "127.0.0.1",
    "-p",
    String(port),
    "-sd",
    storeDir,
  ];
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
      // Older Studio versions wrote `wsPort` while running operator/JWT mode.
      // That server rejects the new credential-free local connection, so
      // restart it once instead of reusing an incompatible process.
      if (existing.wsPort === undefined) {
        // Operator/JWT keys from an older Studio release are no longer used.
        // Remove the dormant secrets even when the current plain server is
        // already healthy.
        rmSync(join(servicesDir(home), "nats", "jwt"), {
          recursive: true,
          force: true,
        });
        info.state = "running";
        info.pid = existing.pid;
        info.port = existing.port;
        info.owner = "managed";
        return info;
      }
      await stopNats(home);
    } else {
      // Dead process — clean up stale state
      await removeState(home, "nats");
    }
  }

  // Retired operator/account seeds are sensitive and have no remaining
  // consumer. The path is an exact app-managed subdirectory, never user input.
  rmSync(join(servicesDir(home), "nats", "jwt"), {
    recursive: true,
    force: true,
  });

  // Allocate one dynamic loopback port for Studio's local connection.
  const port = await findAvailablePort();
  info.port = port;

  const binPath = await downloadNats(home);
  const dataDir = join(servicesDir(home), "nats", "data");
  const logDir = join(servicesDir(home), "nats");
  ensureDir(dataDir);

  const logFile = Bun.file(join(logDir, "nats.log"));
  const proc = Bun.spawn(managedNatsCommand(binPath, port, dataDir), {
    stdout: logFile,
    stderr: logFile,
  });

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
    await sleep(200);
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
// MinIO (auto-downloaded binary — S3-compatible object storage for dev)
// ---------------------------------------------------------------------------
//
// In dev we auto-provision a real S3-compatible store (MinIO) so file uploads,
// generated assets, and run attachments use the same S3Service as production
// rather than the DevObjectStorage fallback.
//
// MinIO publishes per-OS/arch *server* binaries at a stable URL:
//   https://dl.min.io/server/minio/release/<os>-<arch>/minio[.exe]

/**
 * Build the MinIO server binary artifact name for an os/arch pair.
 *
 * Pure (no IO) so it is unit-testable. `os`/`arch` are the values returned by
 * `os.platform()` / `os.arch()`. Only the platform name affects the artifact
 * file name (`minio` vs `minio.exe`); the os/arch pair selects the release
 * directory in {@link minioDownloadUrl}.
 */
export function minioArtifactName(os: string, _arch: string): string {
  return os === "win32" ? "minio.exe" : "minio";
}

/**
 * Build the MinIO server binary download URL for an os/arch pair.
 *
 * Pure (no IO) so it is unit-testable. Throws on an unsupported platform.
 */
export function minioDownloadUrl(os: string, arch: string): string {
  const osMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };

  const archMap: Record<string, string> = {
    arm64: "arm64",
    x64: "amd64",
  };

  const osName = osMap[os];
  const archName = archMap[arch];

  if (!osName || !archName) {
    throw new Error(`Unsupported platform for MinIO: ${os}/${arch}`);
  }

  const artifact = minioArtifactName(os, arch);
  return `https://dl.min.io/server/minio/release/${osName}-${archName}/${artifact}`;
}

function minioBinaryPath(home: string): string {
  return join(servicesDir(home), "minio", "bin", `minio${EXE_EXT}`);
}

async function downloadMinio(home: string): Promise<string> {
  const binPath = minioBinaryPath(home);
  if (existsSync(binPath)) return binPath;

  const binDir = join(servicesDir(home), "minio", "bin");
  ensureDir(binDir);

  const url = minioDownloadUrl(platform(), arch());
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download MinIO: ${response.status} ${response.statusText}`,
    );
  }

  // MinIO ships the raw executable (not an archive). Write to a temp path then
  // atomically rename into place, so an interrupted/partial write never leaves a
  // truncated binary at `binPath` that the existsSync guard above would return
  // forever. Mirrors downloadNats's temp-then-materialize pattern.
  const arrayBuffer = await response.arrayBuffer();
  const tmpPath = `${binPath}.download-${process.pid}`;
  writeFileSync(tmpPath, Buffer.from(arrayBuffer));

  if (!IS_WINDOWS) {
    await chmod(tmpPath, 0o755);
  }

  renameSync(tmpPath, binPath);

  if (!existsSync(binPath)) {
    throw new Error(`MinIO binary not found at ${binPath} after download`);
  }

  return binPath;
}

/** Poll MinIO's readiness endpoint — 200 means the object layer can serve. */
async function waitForMinioReady(
  port: number,
  timeoutMs = 30_000,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/minio/health/ready`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await sleep(200).catch(() => {});
  }
  throw new Error(`Timed out waiting for MinIO readiness at ${url}`);
}

/**
 * Create the dev bucket (idempotent). Uses the already-installed
 * @aws-sdk/client-s3 so there's no `mc` version to keep in sync.
 */
async function provisionMinioBucket(endpoint: string): Promise<void> {
  const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");

  const client = new S3Client({
    endpoint,
    region: "auto",
    credentials: {
      accessKeyId: MINIO_ROOT_USER,
      secretAccessKey: MINIO_ROOT_PASSWORD,
    },
    forcePathStyle: true,
  });

  try {
    // Right after a MinIO (re)start — e.g. a container restart in the
    // resilience suite — the health endpoint can report ready a beat before the
    // S3 API accepts connections, so the first CreateBucket races into
    // ECONNREFUSED/ECONNRESET and the AWS SDK gives up after its 3 internal
    // retries. Left unhandled that rejection propagates out of `buildSettings`
    // and kills studio boot, and under `restart: unless-stopped` it crash-loops
    // (each ~30s cycle blowing the pod-crash scenario's health-wait budget).
    // Ride out only transient connect-level failures here; genuine errors
    // (auth/config, BucketAlreadyOwnedByUs/Exists) are not retriable and fall
    // through to the handling below unchanged.
    await retry(
      () => client.send(new CreateBucketCommand({ Bucket: MINIO_DEV_BUCKET })),
      {
        maxAttempts: 5,
        minTimeout: 200,
        maxTimeout: 3_000,
        isRetriable: (err) =>
          err instanceof Error &&
          /ECONNREFUSED|ECONNRESET|EPIPE|socket|fetch failed|timed out|network/i.test(
            `${(err as { name?: string }).name ?? ""} ${err.message}`,
          ),
      },
    );
  } catch (e: unknown) {
    // BucketAlreadyOwnedByUs / BucketAlreadyExists — fine, it's persistent.
    const name =
      e && typeof e === "object" && "name" in e ? String(e.name) : "";
    if (
      name !== "BucketAlreadyOwnedByUs" &&
      name !== "BucketAlreadyExists" &&
      !(e instanceof Error && e.message.includes("already"))
    ) {
      // A genuine bucket-create failure leaves object-backed features unusable,
      // so let it propagate and abort startup.
      client.destroy();
      throw e;
    }
  }

  client.destroy();
}

async function ensureMinio(home: string): Promise<ServiceInfo> {
  const info: ServiceInfo = {
    name: "MinIO",
    state: "stopped",
    pid: null,
    port: 0,
    owner: "none",
  };

  // Check state.json for an existing managed instance
  const existing = readState(home, "minio");
  if (existing !== null) {
    if (isOwnedProcess(existing.pid, "minio")) {
      info.state = "running";
      info.pid = existing.pid;
      info.port = existing.port;
      info.owner = "managed";
      // Always provision the bucket on every dev start — provisionMinioBucket
      // is idempotent (bucket create swallows BucketAlreadyOwnedByUs/Exists).
      // This ensures the bucket exists even if a previous run wrote state.json
      // but crashed before completing provisioning.
      await provisionMinioBucket(`http://127.0.0.1:${existing.port}`);
      return info;
    }
    // Dead process — clean up stale state
    await removeState(home, "minio");
  }

  // Allocate a dynamic port
  const port = await findAvailablePort();
  info.port = port;

  const binPath = await downloadMinio(home);
  const dataDir = join(servicesDir(home), "minio", "data");
  const logDir = join(servicesDir(home), "minio");
  ensureDir(dataDir);

  const logFile = Bun.file(join(logDir, "minio.log"));
  const proc = Bun.spawn(
    [binPath, "server", dataDir, "--address", `:${port}`],
    {
      env: {
        ...process.env,
        MINIO_ROOT_USER,
        MINIO_ROOT_PASSWORD,
      },
      stdout: logFile,
      stderr: logFile,
    },
  );

  writeState(home, "minio", {
    pid: proc.pid,
    port,
    startedAt: new Date().toISOString(),
  });

  await waitForMinioReady(port);
  await provisionMinioBucket(`http://127.0.0.1:${port}`);

  info.state = "running";
  info.pid = proc.pid;
  info.owner = "managed";
  return info;
}

async function stopMinio(home: string): Promise<void> {
  const state = readState(home, "minio");
  if (state === null) {
    console.log("MinIO: not running");
    return;
  }

  const { pid } = state;

  if (!isProcessAlive(pid)) {
    console.log("MinIO: process already dead, cleaning up state");
    await removeState(home, "minio");
    return;
  }

  if (!isOwnedProcess(pid, "minio")) {
    console.log(
      `MinIO: PID ${pid} no longer belongs to minio (possible PID reuse), cleaning up state`,
    );
    await removeState(home, "minio");
    return;
  }

  console.log(`MinIO: stopping (PID ${pid})...`);

  if (IS_WINDOWS) {
    Bun.spawn(["taskkill", "/PID", String(pid)]);
  } else {
    process.kill(pid, "SIGTERM");
  }

  const start = Date.now();
  while (Date.now() - start < 5000 && isProcessAlive(pid)) {
    await sleep(200);
  }

  if (isProcessAlive(pid) && isOwnedProcess(pid, "minio")) {
    console.log("MinIO: force killing...");
    if (IS_WINDOWS) {
      Bun.spawn(["taskkill", "/PID", String(pid), "/F"]);
    } else {
      process.kill(pid, "SIGKILL");
    }
  }

  await removeState(home, "minio");
  console.log("MinIO stopped");
}

function portFromUrl(url: string, fallback: number): number {
  try {
    const parsed = new URL(url);
    return parsed.port ? Number.parseInt(parsed.port, 10) : fallback;
  } catch {
    return fallback;
  }
}

export async function ensureServices(inputs: ServiceInputs): Promise<{
  services: ServiceInfo[];
  outputs: ServiceOutputs;
}> {
  ensureDir(servicesDir(inputs.home));

  const skipPostgres = inputs.externalDatabaseUrl !== null;
  const skipNats = inputs.externalNatsUrl !== null;
  // Skip managed MinIO when an external S3 store is already configured (CI/prod
  // set S3_ENDPOINT + bucket + credentials) or when the caller opts out.
  const externalS3 = Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY,
  );
  const skipMinio = inputs.skipMinio === true || externalS3;

  const pgInfo: ServiceInfo = skipPostgres
    ? {
        name: "PostgreSQL",
        state: "external",
        pid: null,
        port: portFromUrl(inputs.externalDatabaseUrl!, 5432),
        owner: "external",
      }
    : await ensurePostgres(inputs.home);

  let natsInfo: ServiceInfo;
  if (skipNats) {
    natsInfo = {
      name: "NATS",
      state: "external",
      pid: null,
      port: portFromUrl(inputs.externalNatsUrl!, 4222),
      owner: "external",
    };
  } else {
    natsInfo = await ensureNats(inputs.home);
  }

  const services: ServiceInfo[] = [pgInfo, natsInfo];

  // Object storage. Managed MinIO unless an external S3 store is configured.
  let s3: ServiceOutputs["s3"] = null;
  if (externalS3) {
    services.push({
      name: "MinIO",
      state: "external",
      pid: null,
      port: portFromUrl(process.env.S3_ENDPOINT!, MINIO_DEFAULT_PORT),
      owner: "external",
    });
    s3 = {
      endpoint: process.env.S3_ENDPOINT!,
      bucket: process.env.S3_BUCKET!,
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: resolveS3ForcePathStyle(process.env.S3_FORCE_PATH_STYLE),
    };
  } else if (!skipMinio) {
    const minioInfo = await ensureMinio(inputs.home);
    services.push(minioInfo);
    s3 = {
      endpoint: `http://127.0.0.1:${minioInfo.port}`,
      bucket: MINIO_DEV_BUCKET,
      accessKeyId: MINIO_ROOT_USER,
      secretAccessKey: MINIO_ROOT_PASSWORD,
      forcePathStyle: true,
    };
  }

  // Mirror the resolved S3 config into process.env BEFORE the app constructs
  // its S3Service. The in-process serve path reads frozen Settings (threaded
  // via `outputs.s3` in pipeline.ts); the dev path spawns `dev:servers` as a
  // child that re-derives Settings from the inherited process.env, so set both.
  if (s3) {
    process.env.S3_ENDPOINT = s3.endpoint;
    process.env.S3_BUCKET = s3.bucket;
    process.env.S3_ACCESS_KEY_ID = s3.accessKeyId;
    process.env.S3_SECRET_ACCESS_KEY = s3.secretAccessKey;
    // Mirror the resolved path-style choice into env so a spawned `dev:servers`
    // child re-derives the same value. We only ever write "true" (managed MinIO,
    // or external S3 defaulting to path-style when S3_FORCE_PATH_STYLE is unset);
    // an explicit "false" the operator set is left untouched.
    if (s3.forcePathStyle) {
      process.env.S3_FORCE_PATH_STYLE = "true";
    }
  }

  const databaseUrl = skipPostgres
    ? inputs.externalDatabaseUrl!
    : pgConnectionString(pgInfo.port);

  const natsUrl = skipNats
    ? inputs.externalNatsUrl!
    : `nats://127.0.0.1:${natsInfo.port}`;

  return {
    services,
    outputs: {
      databaseUrl,
      natsUrls: [natsUrl],
      s3,
    },
  };
}

export async function stopServices(home: string): Promise<void> {
  await stopPostgres(home);
  await stopNats(home);
  await stopMinio(home);
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

  const minioState = readState(home, "minio");
  if (minioState !== null && isProcessAlive(minioState.pid)) {
    services.push({
      name: "MinIO",
      state: "running",
      pid: minioState.pid,
      port: minioState.port,
      owner: "managed",
    });
  } else {
    if (minioState !== null) await removeState(home, "minio");
    services.push({
      name: "MinIO",
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

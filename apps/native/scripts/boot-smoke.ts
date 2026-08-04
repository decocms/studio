#!/usr/bin/env bun
/**
 * `bun run --cwd apps/native smoke:boot`
 *
 * End-to-end boot smoke for the Tauri shell (`apps/native/src-tauri/`):
 *
 *   1. By default, ensures the release `.app` bundle exists
 *      (`bunx @tauri-apps/cli build`) and is newer than its inputs — the same
 *      profile the shipped app uses, so the smoke gates what ships. Pass
 *      `--rebuild` to force a fresh build after touching Rust or frontend
 *      source. CI, which already built the exact artifact it needs to test,
 *      passes `--require-existing-bundle` to fail when that `.app` is absent
 *      and never rebuild it.
 *   2. Launches `Contents/MacOS/<bin>` DIRECTLY (not `open -a`, which
 *      detaches from this process's stdio/exit-code and complicates
 *      cleanup) with `DESKTOP_SELFTEST=1`,
 *      `DESKTOP_SELFTEST_APP_DATA_DIR=<unique tmp root>/app-data`, and
 *      `DESKTOP_SELFTEST_OUT=<unique tmp report>` — see
 *      `src-tauri/src/selftest.rs` for what that mode does.
 *   3. Waits for the process to exit (bounded — `SELFTEST_DEADLINE_MS`),
 *      asserts exit code 0.
 *   4. Reads the results file, asserts `allPass === true`, prints a
 *      per-check summary table (pass/fail/informational).
 *   5. Checks for orphaned children: captures the app's OS-level
 *      descendant PIDs while it's running, then asserts none of them are
 *      still alive after it exits (`pgrep -P <pid>`, plus a broad
 *      `pgrep -f` sweep for the standalone `local-api`/`deco`
 *      binaries in case something detached from the process tree
 *      entirely — e.g. a double-forked PTY child).
 *
 * Each run creates one unique `desktop-boot-smoke-*` directory under the
 * system temp root and passes its `app-data` child to the native shell via
 * `DESKTOP_SELFTEST_APP_DATA_DIR`. The shell requires and validates that
 * override in self-test mode, so this script can never open or delete the
 * real `com.decocms.studio` app data.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "@decocms/shared/std";
import {
  BOOT_SMOKE_TEMP_PREFIX,
  type BootSmokePaths,
  resolveBootSmokePaths,
} from "./boot-smoke-paths";
import {
  type BootSmokeBundleMode,
  parseBootSmokeOptions,
  resolveBootSmokeBundleAction,
} from "./boot-smoke-options";

const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const APP_BINARY_NAME = "deco";
const APP_BUNDLE = join(
  DESKTOP_DIR,
  `target/release/bundle/macos/${APP_BINARY_NAME}.app`,
);
const TAURI_CLI_VERSION = "2.11.4";
const SELFTEST_DEADLINE_MS = 60_000;
const ORPHAN_CHECK_SETTLE_MS = 1000;

interface SelftestCheck {
  ok?: boolean;
  status?: number;
  error?: string;
  attempts?: number;
  [k: string]: unknown;
}

interface SelftestReport {
  allPass: boolean;
  results: Record<string, SelftestCheck>;
}

function log(msg: string): void {
  console.log(`[boot-smoke] ${msg}`);
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** `spawn` + wait for exit, streaming stdio, returning the exit code. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "inherit",
    });
    proc.once("error", reject);
    proc.once("exit", (code) => resolve(code ?? 1));
  });
}

function binaryPath(): string {
  const macosDir = join(APP_BUNDLE, "Contents/MacOS");
  if (!existsSync(macosDir)) {
    fail(`bundle exists but ${macosDir} is missing — build may have failed`);
  }
  // The app binary is no longer alone in here: Tauri copies every
  // `externalBin` sidecar (currently `rclone`, which serves the organization
  // filesystem) into this same directory, with its target triple stripped.
  // Select the app by name rather than asserting the directory's size, so
  // adding a sidecar does not break the smoke test.
  const entries = readdirSync(macosDir);
  if (!entries.includes(APP_BINARY_NAME)) {
    fail(
      `${APP_BINARY_NAME} is missing from ${macosDir}, found: ${entries.join(", ")}`,
    );
  }
  return join(macosDir, APP_BINARY_NAME);
}

/** Newest file mtime under `dir` (recursive, sync — this is a dev script,
 *  not the daemon; the walked trees hold no node_modules). 0 if absent. */
function newestMtimeUnder(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtimeUnder(p) : statSync(p).mtimeMs,
    );
  }
  return newest;
}

async function ensureBuilt(bundleMode: BootSmokeBundleMode): Promise<void> {
  const action = resolveBootSmokeBundleAction(
    bundleMode,
    existsSync(APP_BUNDLE),
  );
  if (action === "reject-missing") {
    fail(
      `--require-existing-bundle was passed but ${APP_BUNDLE} does not exist`,
    );
  }
  if (action === "use-existing") {
    log(`using required existing bundle at ${APP_BUNDLE}`);
    return;
  }

  if (action === "check-freshness") {
    // Staleness guard: the bundle bakes the frontend + Rust in at build
    // time, so an existing .app can silently predate both. A stale bundle
    // is exactly how a fixed frontend kept shipping a blank window on
    // 2026-07-19 — the smoke passed against yesterday's .app. Rebuild
    // whenever a known input is newer than the bundled binary.
    //
    // Frontend freshness is judged from SOURCE mtimes, not dist/native:
    // since the HMR dev loop landed (`bun run dev:native` serves source via
    // the Vite dev server), nothing in the routine dev workflow refreshes
    // dist/native anymore, so its mtime is a dead signal — comparing it
    // would re-open the same stale-bundle false-green this guard exists to
    // prevent. When source IS newer, the rebuild's own beforeBuildCommand
    // (`build:native`) regenerates dist/native before bundling.
    const bundleBin = statSync(binaryPath()).mtimeMs;
    const webDir = join(DESKTOP_DIR, "..", "web");
    const inputs = [
      join(DESKTOP_DIR, "target", "release", "deco"),
      join(DESKTOP_DIR, "src-tauri", "tauri.conf.json5"),
      join(webDir, "index.native.html"),
      join(webDir, "vite.config.ts"),
      join(webDir, "package.json"),
    ].filter(existsSync);
    const newest = Math.max(
      ...inputs.map((f) => statSync(f).mtimeMs),
      newestMtimeUnder(join(DESKTOP_DIR, "crates")),
      newestMtimeUnder(join(DESKTOP_DIR, "src-tauri", "src")),
      newestMtimeUnder(join(webDir, "src")),
      newestMtimeUnder(join(webDir, "public")),
    );
    if (newest <= bundleBin) {
      log(`found fresh bundle at ${APP_BUNDLE} (pass --rebuild to force)`);
      return;
    }
    log("existing bundle is older than its inputs — rebuilding");
  }
  log(
    `building release app bundle: bunx @tauri-apps/cli@${TAURI_CLI_VERSION} build --bundles app`,
  );
  const code = await run(
    "bunx",
    [`@tauri-apps/cli@${TAURI_CLI_VERSION}`, "build", "--bundles", "app"],
    { cwd: DESKTOP_DIR },
  );
  if (code !== 0) {
    fail(`tauri build exited ${code}`);
  }
  if (!existsSync(APP_BUNDLE)) {
    fail(`build reported success but ${APP_BUNDLE} does not exist`);
  }
}

/** The only recursive delete in this script. Re-validates the generated root
 * immediately before deletion so later refactors cannot broaden the target. */
function cleanupSmokeDir(paths: BootSmokePaths): void {
  try {
    const validated = resolveBootSmokePaths(paths.root, tmpdir());
    rmSync(validated.root, { recursive: true, force: true });
  } catch (err) {
    log(`warning: failed to clean isolated smoke directory: ${err}`);
  }
}

/** Direct children of `pid` still alive, via `pgrep -P`. Empty on macOS
 *  when there are none (pgrep exits 1, not an error for our purposes). */
function livingChildPids(pid: number): number[] {
  const res = Bun.spawnSync(["pgrep", "-P", String(pid)]);
  const out = res.stdout.toString().trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/** Broad sweep for the standalone binaries by name — catches a child that
 *  detached from the process tree entirely (e.g. a double-forked PTY
 *  child), which `pgrep -P` alone would miss. */
/** All PIDs matching the desktop binaries, for the pre/post orphan diff. */
function sweepForBinaries(): number[] {
  // Each pattern ends the binary name at a word boundary (whitespace before
  // args, or end of the command line). Without it, the bare `deco` prefix
  // also matches sibling target binaries — `decocms-keychain-helper`, a
  // dev-run `deco`-prefixed build — and a process spawning during the smoke
  // window gets misreported as a leaked orphan.
  return [
    ...livingProcessesMatching("target/(debug|release)/deco([[:space:]]|$)"),
    ...livingProcessesMatching(
      "target/(debug|release)/bundle/macos/deco\\.app/Contents/MacOS/deco([[:space:]]|$)",
    ),
    ...livingProcessesMatching(
      "target/(debug|release)/local-api([[:space:]]|$)",
    ),
  ];
}

function livingProcessesMatching(pattern: string): number[] {
  const res = Bun.spawnSync(["pgrep", "-f", pattern]);
  const out = res.stdout.toString().trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/** SIGKILLs `pid`, swallowing the case where it has already exited. */
function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already exited — nothing to clean up
  }
}

/** Kills every process matched by `sweepForBinaries` that wasn't already
 *  running before this smoke run (`preExisting`). `fail()` throws as soon as
 *  a failure is detected — deadline timeout, non-zero exit, or a detected
 *  orphan — well before the code that would otherwise notice these
 *  processes, so a failed run needs its own reap or it leaks the app/
 *  local-api/rclone processes it spawned into the next run. */
function reapStrayProcesses(preExisting: Set<number>): void {
  const stray = sweepForBinaries().filter((p) => !preExisting.has(p));
  for (const p of stray) killIfAlive(p);
  if (stray.length > 0) {
    log(`reaped ${stray.length} stray process(es): ${stray.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const options = parseBootSmokeOptions(process.argv.slice(2));

  await ensureBuilt(options.bundleMode);
  const bin = binaryPath();
  log(`binary: ${bin}`);

  const outDir = mkdtempSync(join(tmpdir(), BOOT_SMOKE_TEMP_PREFIX));
  const smokePaths = resolveBootSmokePaths(outDir, tmpdir());
  const outFile = smokePaths.reportFile;

  // Snapshot matching PIDs that exist BEFORE our launch: another dev's
  // running app, a parallel CI job, or a manually-started local-api must
  // not fail OUR orphan check. Only processes that appear during the smoke
  // and survive it count as orphans.
  const preExisting = new Set(sweepForBinaries());
  let pid: number | undefined;

  try {
    log(`isolated app data: ${smokePaths.appDataDir}`);
    log("launching with DESKTOP_SELFTEST=1 …");
    const proc = spawn(bin, [], {
      env: {
        ...process.env,
        DESKTOP_SELFTEST: "1",
        DESKTOP_SELFTEST_APP_DATA_DIR: smokePaths.appDataDir,
        // Visible by default: macOS App Nap throttles network-response
        // delivery to hidden windows, wedging the self-test's fetches with
        // no report (observed live 2026-07-19 — requests reached local-api,
        // responses never reached the hidden page). A briefly visible
        // window is the lesser evil everywhere, including CI's GUI session.
        // Set DESKTOP_SELFTEST_VISIBLE=0 to force the old hidden behavior.
        DESKTOP_SELFTEST_VISIBLE: process.env.DESKTOP_SELFTEST_VISIBLE ?? "1",
        DESKTOP_SELFTEST_OUT: outFile,
        // This is a RELEASE-profile build at the committed 0.1.0 placeholder
        // version — never let it "update" itself from the production channel
        // mid-smoke. (The updater task also refuses to spawn under selftest
        // and at 0.1.0; this is belt-and-braces for local runs.)
        DECOCMS_DISABLE_AUTO_UPDATE: "1",
        // Boot smoke validates the shell/IPC contract, not the operator's real
        // login. Never let its auth-status probe open a macOS ACL dialog for the
        // production Keychain item; persistence itself is covered by the
        // isolated-Keychain fresh-process E2E suite.
        LOCAL_API_TOKEN_STORE: "memory",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    pid = proc.pid;
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr?.on("data", (c) => {
      stderr += c.toString();
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        log(
          `deadline (${SELFTEST_DEADLINE_MS}ms) exceeded — killing pid ${pid}`,
        );
        proc.kill("SIGKILL");
      }, SELFTEST_DEADLINE_MS);
      proc.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === null) {
          reject(
            new Error(
              `process was killed by signal ${signal} before self-test completed`,
            ),
          );
          return;
        }
        resolve(code);
      });
    });

    console.log("--- app stdout/stderr ---");
    console.log(stdout);
    console.error(stderr);
    console.log("-------------------------");

    if (exitCode !== 0) {
      fail(`app exited ${exitCode} (expected 0) — see stdout/stderr above`);
    }

    if (!existsSync(outFile)) {
      fail("app exited 0 but the isolated self-test report was never written");
    }
    const report = JSON.parse(readFileSync(outFile, "utf8")) as SelftestReport;

    log("self-test results:");
    const gatingKeys = new Set([
      "localApiInfo",
      "sameOriginControl",
      "health200Public",
      "session401WithoutCookie",
      "session204WithCookie",
      "bootstrapSecretOneTime",
      "protectedRoute200WithCookie",
      "credentiallessMutationRejected",
      "eventSourceStatusEvent",
      "controlCookieIsolation",
      "authStatusInvoke",
      "domMountedEarly",
      "remoteImageLoads",
      "previewIframeLoads",
      "previewFetchReachable",
      "noCspViolations",
    ]);
    for (const [name, check] of Object.entries(report.results)) {
      const tag = check.ok ? "PASS" : gatingKeys.has(name) ? "FAIL" : "INFO";
      const detail =
        check.error ??
        (check.status !== undefined ? `status=${check.status}` : "");
      log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
    }

    if (!report.allPass) {
      fail("self-test report has allPass=false — see results above");
    }
    log("self-test report: allPass=true");

    // --- orphan check --------------------------------------------------
    await sleep(ORPHAN_CHECK_SETTLE_MS);
    const orphanedChildren = pid ? livingChildPids(pid) : [];
    const orphanedByName = sweepForBinaries().filter(
      (p) => !preExisting.has(p),
    );
    const allOrphans = [...new Set([...orphanedChildren, ...orphanedByName])];
    if (allOrphans.length > 0) {
      fail(
        `${allOrphans.length} orphaned process(es) still alive after exit: ${allOrphans.join(", ")}`,
      );
    }
    log("orphan check: no leftover children");

    log("SUMMARY: boot smoke PASSED");
    log(`  bundle:        ${APP_BUNDLE}`);
    log(`  binary:        ${bin}`);
    log(`  exit code:     ${exitCode}`);
    log(`  allPass:       ${report.allPass}`);
    log(`  orphan check:  clean`);
  } finally {
    if (pid !== undefined) killIfAlive(pid);
    reapStrayProcesses(preExisting);
    cleanupSmokeDir(smokePaths);
  }
}

main().catch((err) => {
  console.error(
    `[boot-smoke] FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exitCode = 1;
});

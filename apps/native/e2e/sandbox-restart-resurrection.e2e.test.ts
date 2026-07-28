/**
 * Black-box verification for the owner-reported sandbox drawer bugs (see
 * the native local-API contract's "Setup / clone pipeline"
 * section, "Backend-restart self-heal" + `POST /_sandbox/setup/stop"):
 *
 *   (1) Stop did nothing in Tauri — `POST /_sandbox/setup/stop` (NEW) now
 *       kills the resolved target's running `dev`/`start` task WITHOUT
 *       re-spawning it.
 *   (2) After a local-api backend restart (dev-loop rebuild), Restart
 *       (`POST /_sandbox/setup/start`) used to enqueue against a MEANINGLESS
 *       target (the process-global orchestrator, never configured) — nothing
 *       streamed to the drawer's SSE. `start` now self-heals: it resurrects
 *       the forgotten sandbox from its persisted `GitSandboxConfig` sidecar
 *       (`apps/native/crates/local-api/src/sandbox/persist.rs`) and actually
 *       restarts ITS dev server, observable on the SAME SSE stream the
 *       drawer watches.
 *
 * Drives the REAL `local-api` binary (via `LOCAL_API_E2E_CMD`, see
 * `helpers.ts`) against a REAL local `file://`-style bare-repo git fixture —
 * mirrors `sandbox-resolution.e2e.test.ts`/`git-sandbox.e2e.test.ts`'s
 * fixture conventions. The "restart" is a REAL `SIGKILL` + relaunch of the
 * binary against the SAME `LOCAL_API_WORKDIR` (`startLocalApi`'s
 * `opts.workdir` / `stopLocalApi`'s `opts.keepWorkdir` — see `helpers.ts`),
 * not a simulated/mocked one — the whole point is proving the ON-DISK state
 * (workdir + sidecar) survives a real process death while the IN-MEMORY
 * `SandboxManager` state does not.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sleep } from "@decocms/shared/std";
import { afterEach, expect, it } from "bun:test";
import { computeHandle, repoDirFor, sandboxDirFor } from "./sandbox-handle";

import {
  signInAndCompleteSession,
  startAuthenticatedUpstream,
} from "./authenticated-upstream";
import {
  authHeaders,
  describeLocalApi,
  jsonAuthHeaders,
  readSseUntil,
  startLocalApi,
  stopLocalApi,
  stubClaudeBinEnv,
  url,
  type LocalApi,
} from "./helpers";

function git(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`,
    );
  }
}

const PACKAGE_JSON = JSON.stringify({
  name: "sandbox-restart-resurrection-fixture",
  private: true,
  scripts: {
    postinstall: "node -e \"console.log('SANDBOX_INSTALL_COMPLETE')\"",
    dev: "node server.js",
  },
});

const SERVER_JS = `
const http = require("http");
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<html><body>ok</body></html>");
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  console.log("Local: http://localhost:" + addr.port + "/");
});
`;

/** A bare "origin" with one commit + a real bindable dev server — returns
 * the bare repo's filesystem path (used directly as `cloneUrl`). */
function setupFixtureRepo(packageJson = PACKAGE_JSON): {
  root: string;
  bareDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "sandbox-restart-e2e-"));
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "author");
  git(root, ["init", "--bare", "-q", bareDir]);
  git(root, ["init", "-q", "-b", "main", workDir]);
  git(workDir, ["config", "user.name", "Test User"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(workDir, "package.json"), packageJson);
  writeFileSync(join(workDir, "server.js"), SERVER_JS);
  git(workDir, ["add", "."]);
  git(workDir, ["commit", "-q", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", bareDir]);
  git(workDir, ["push", "-q", "-u", "origin", "main"]);
  git(bareDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, bareDir };
}

/** Dispatches one turn, driving `SandboxManager::ensure` (clone + install +
 * start cascade) exactly like a real chat turn would — mirrors
 * `sandbox-resolution.e2e.test.ts`'s identically-named helper. */
async function dispatchTurn(
  a: LocalApi,
  org: string,
  threadId: string,
  virtualMcpId: string,
  cloneUrl: string,
  branch: string,
): Promise<void> {
  const res = await fetch(
    url(a, `/api/${org}/decopilot/threads/${threadId}/messages`),
    {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        messages: [
          { role: "user", parts: [{ type: "text", text: "SCENARIO:simple" }] },
        ],
        tier: "smart",
        mode: "default",
        toolApprovalLevel: "auto",
        agent: { id: virtualMcpId },
        harnessId: "claude-code",
        branch,
        sandbox: {
          virtualMcpId,
          repo: { cloneUrl, branch },
          workload: { runtime: "bun", packageManager: "bun" },
        },
      }),
    },
  );
  expect(res.status).toBe(202);

  const streamRes = await fetch(
    url(a, `/api/${org}/decopilot/threads/${threadId}/stream`),
    { headers: jsonAuthHeaders() },
  );
  expect(streamRes.status).toBe(200);
  await streamRes.text();
}

interface TaskSummary {
  id: string;
  status: string;
  logName: string | null;
}

async function listTasks(a: LocalApi, handle?: string): Promise<TaskSummary[]> {
  const res = await fetch(url(a, "/_sandbox/tasks"), {
    headers: authHeaders(handle ? { "x-decocms-sandbox-handle": handle } : {}),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tasks: TaskSummary[] };
  return body.tasks;
}

/** The production UI's desktop control-plane entry point. Unlike a chat
 * dispatch, this route needs no harness/upstream session: it materializes the
 * focused repo, durably registers its meaning, and reconciles it to running. */
async function ensureSandbox(
  a: LocalApi,
  virtualMcpId: string,
  cloneUrl: string,
  branch = "main",
): Promise<string> {
  const response = await fetch(url(a, "/_sandbox/setup/ensure"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      virtualMcpId,
      repo: { cloneUrl, branch },
      workload: { runtime: "bun", packageManager: "bun" },
    }),
  });
  // Surface the server's reason: a bare status assertion turns every ensure
  // regression into an unexplained number.
  if (response.status !== 200) {
    throw new Error(
      `ensure ${virtualMcpId} @ ${branch} -> ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { handle?: string };
  expect(body.handle).toBeString();
  return body.handle!;
}

async function waitForFreshRunningTask(
  a: LocalApi,
  handle: string,
  logName: string,
  excludeIds: Set<string>,
  deadlineMs = 20_000,
): Promise<TaskSummary> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const tasks = await listTasks(a, handle);
    const fresh = tasks.find(
      (t) =>
        t.logName === logName &&
        t.status === "running" &&
        !excludeIds.has(t.id),
    );
    if (fresh) return fresh;
    await sleep(200);
  }
  throw new Error(
    `no fresh running "${logName}" task appeared for handle ${handle} within ${deadlineMs}ms`,
  );
}

interface LiveSseCapture {
  text: () => string;
  readUntil: (
    predicate: (text: string) => boolean,
    deadlineMs?: number,
  ) => Promise<string>;
  close: () => Promise<void>;
}

/** One continuously-open SSE response, matching the drawer's real lifetime.
 * Reopening a response after Resume would only prove replay on a fresh mount;
 * it would miss the same-handle generation-switch regression. */
async function openLiveSseCapture(
  eventsUrl: string,
  deadlineMs = 10_000,
): Promise<LiveSseCapture> {
  const response = await fetch(eventsUrl, { headers: jsonAuthHeaders() });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  let captured = "";

  return {
    text: () => captured,
    readUntil: async (predicate, timeoutMs = deadlineMs) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(captured)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `SSE predicate not met; captured tail: ${captured.slice(-2000)}`,
          );
        }
        const next = await Promise.race([
          reader.read().then((value) => ({ kind: "read" as const, value })),
          sleep(remaining).then(() => ({ kind: "timeout" as const })),
        ]);
        if (next.kind === "timeout") {
          throw new Error(
            `SSE read timed out; captured tail: ${captured.slice(-2000)}`,
          );
        }
        if (next.value.done) {
          throw new Error(
            `SSE closed early; captured tail: ${captured.slice(-2000)}`,
          );
        }
        captured += decoder.decode(next.value.value, { stream: true });
      }
      return captured;
    },
    close: async () => {
      await reader.cancel().catch(() => {});
    },
  };
}

function devPorts(text: string): number[] {
  return [...text.matchAll(/Local: http:\/\/localhost:(\d+)\//g)].map((match) =>
    Number(match[1]),
  );
}

function hasDevScriptsEvent(text: string): boolean {
  return text.split("\n\n").some((frame) => {
    if (!frame.startsWith("event: scripts\n")) return false;
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (!data) return false;
    try {
      const parsed = JSON.parse(data) as { scripts?: unknown };
      return Array.isArray(parsed.scripts) && parsed.scripts.includes("dev");
    } catch {
      return false;
    }
  });
}

async function expectPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(300),
      });
      await response.body?.cancel().catch(() => {});
    } catch {
      return;
    }
    await sleep(100);
  }
  throw new Error(`dev server still accepts connections on port ${port}`);
}

/** Establishes a real git sandbox (clone + install + running dev server),
 * then `SIGKILL`s local-api WITHOUT deleting its workdir — a real backend
 * restart, not a simulation. Returns everything a test needs to relaunch
 * against the SAME workdir and assert on the resurrected sandbox. */
async function establishThenKill(vmcpSuffix: string): Promise<{
  workdir: string;
  fixtureRoot: string;
  bareDir: string;
  virtualMcpId: string;
  handle: string;
  upstream: ReturnType<typeof startAuthenticatedUpstream>;
}> {
  const fixture = setupFixtureRepo();
  const upstream = startAuthenticatedUpstream();
  const virtualMcpId = `sandbox-restart-e2e-${vmcpSuffix}`;
  const handle = computeHandle(fixture.bareDir, "main");
  const a = await startLocalApi(
    stubClaudeBinEnv({
      DECOCMS_UPSTREAM_URL: upstream.url,
      LOCAL_API_TOKEN_STORE: "memory",
    }),
  );
  await signInAndCompleteSession(a);
  await dispatchTurn(
    a,
    "sandbox-restart-org",
    `thread-${vmcpSuffix}`,
    virtualMcpId,
    fixture.bareDir,
    "main",
  );
  // `ensure()` returns once clone/checkout are done but install+start
  // cascade asynchronously — wait for the REAL dev server before killing,
  // so this is provably "a sandbox that was actually running", not one
  // still mid-clone.
  await waitForFreshRunningTask(a, handle, "dev", new Set());

  // `.proc.kill("SIGKILL")` inside stopLocalApi — no graceful shutdown, no
  // hooks run, exactly like the owner-reported "backend restarts (dev-loop
  // rebuild)" scenario. `keepWorkdir` so the clone + sidecar + logs survive.
  await stopLocalApi(a, { keepWorkdir: true });

  return {
    workdir: a.workdir,
    fixtureRoot: fixture.root,
    bareDir: fixture.bareDir,
    virtualMcpId,
    handle,
    upstream,
  };
}

// Tracks every workdir/fixture-root this file's tests created, so a single
// `afterEach` cleans up regardless of which `it()` is running (avoids
// repeating rmSync-in-a-try/finally in every test body).
let cleanupDirs: string[] = [];
let liveApi: LocalApi | null = null;
let liveUpstream: ReturnType<typeof startAuthenticatedUpstream> | null = null;

afterEach(async () => {
  await stopLocalApi(liveApi, { keepWorkdir: true });
  liveApi = null;
  liveUpstream?.server.stop(true);
  liveUpstream = null;
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs = [];
});

describeLocalApi(
  "local-api e2e: sandbox restart resurrection + setup/stop (owner-reported bugs)",
  () => {
    it("drives the UI control-plane contract: ensure boots once, disk replay feeds setup/dev xterms, Stop kills, and Restart skips clone/install", async () => {
      const fixture = setupFixtureRepo();
      cleanupDirs = [fixture.root];
      const a = await startLocalApi(stubClaudeBinEnv());
      liveApi = a;

      const handle = await ensureSandbox(
        a,
        "sandbox-control-plane-e2e",
        fixture.bareDir,
      );
      const firstDev = await waitForFreshRunningTask(
        a,
        handle,
        "dev",
        new Set(),
      );

      // This is the exact stream the focused desktop drawer opens. Keep this
      // same HTTP response alive through Restart, Stop, Resume, and another
      // sandbox becoming active.
      const eventsUrl = `${url(a, "/_sandbox/events")}?handle=${encodeURIComponent(handle)}`;
      const capture = await openLiveSseCapture(eventsUrl, 20_000);
      const firstReplay = await capture.readUntil(
        (text) =>
          text.includes('"source":"setup"') &&
          text.includes('"source":"dev"') &&
          text.includes("SANDBOX_INSTALL_COMPLETE") &&
          text.includes("Local: http://localhost:"),
      );
      expect(firstReplay).toMatch(/\$ git .*clone/);
      expect(firstReplay).toContain("SANDBOX_INSTALL_COMPLETE");
      expect(firstReplay).toContain("Local: http://localhost:");
      const firstPorts = new Set(devPorts(firstReplay));
      expect(firstPorts.size).toBeGreaterThanOrEqual(1);

      const setupLogPath = join(
        sandboxDirFor(a.workdir, handle),
        "logs",
        "app",
        "setup",
      );
      const setupBeforeRestart = readFileSync(setupLogPath, "utf8");

      // Restart while running is Start-only and fully reaps the old server
      // before admitting the replacement.
      const restartResponse = await fetch(url(a, "/_sandbox/setup/start"), {
        method: "POST",
        headers: authHeaders({ "x-decocms-sandbox-handle": handle }),
      });
      expect(restartResponse.status).toBe(200);
      const secondDev = await waitForFreshRunningTask(
        a,
        handle,
        "dev",
        new Set([firstDev.id]),
      );
      expect(secondDev.id).not.toBe(firstDev.id);
      const afterRestart = await capture.readUntil(
        (text) => new Set(devPorts(text)).size >= 2,
      );
      const restartPorts = [...new Set(devPorts(afterRestart))];
      const restartedPort = restartPorts.at(-1)!;
      expect(readFileSync(setupLogPath, "utf8")).toBe(setupBeforeRestart);

      const stopResponse = await fetch(url(a, "/_sandbox/setup/stop"), {
        method: "POST",
        headers: authHeaders({ "x-decocms-sandbox-handle": handle }),
      });
      expect(stopResponse.status).toBe(200);
      expect(await stopResponse.json()).toMatchObject({
        stopped: true,
        alreadyStopped: false,
      });
      await expectPortClosed(restartedPort);
      const beforeResumeOffset = capture.text().length;

      // Resume uses ensure and creates a fresh in-memory generation. Make a
      // second sandbox active immediately afterward: A's continuously-open
      // explicit SSE must still bind to A's replacement, not the global active
      // pointer. The retained repo/checkpoint makes Resume Start-only.
      expect(
        await ensureSandbox(a, "sandbox-control-plane-e2e", fixture.bareDir),
      ).toBe(handle);
      // A handle is `<repo scope>/<branch>` and carries no agent identity, so
      // a SECOND agent on the same repo+branch joins this sandbox rather than
      // forking or colliding with it. It used to 409 on an identity guard left
      // over from when a handle was `(virtualMcpId, branch)`.
      expect(
        await ensureSandbox(
          a,
          "sandbox-control-plane-e2e-second",
          fixture.bareDir,
        ),
      ).toBe(handle);
      // So a DIFFERENT BRANCH is what makes a genuinely rival sandbox — which
      // is what this test needs to prove A's explicit stream stays bound to A.
      const otherHandle = await ensureSandbox(
        a,
        "sandbox-control-plane-e2e-other",
        fixture.bareDir,
        "control-plane-other",
      );
      expect(otherHandle).not.toBe(handle);
      await waitForFreshRunningTask(a, handle, "dev", new Set(), 20_000);
      const afterResume = await capture.readUntil((text) => {
        const resumedFrames = text.slice(beforeResumeOffset);
        return (
          hasDevScriptsEvent(resumedFrames) && new Set(devPorts(text)).size >= 3
        );
      }, 20_000);
      expect(hasDevScriptsEvent(afterResume.slice(beforeResumeOffset))).toBe(
        true,
      );
      expect(readFileSync(setupLogPath, "utf8")).toBe(setupBeforeRestart);
      expect(afterResume).toContain("SANDBOX_INSTALL_COMPLETE");
      expect(new Set(devPorts(afterResume)).size).toBeGreaterThanOrEqual(3);
      await capture.close();
    }, 60_000);

    it("Stop during install fences the old cascade, and Resume finishes install before starting dev", async () => {
      const slowPackageJson = JSON.stringify({
        name: "sandbox-stop-during-install-fixture",
        private: true,
        scripts: {
          postinstall:
            "node -e \"setTimeout(() => console.log('SLOW_INSTALL_COMPLETE'), 4000)\"",
          dev: "node server.js",
        },
      });
      const fixture = setupFixtureRepo(slowPackageJson);
      cleanupDirs = [fixture.root];
      const a = await startLocalApi(stubClaudeBinEnv());
      liveApi = a;
      const handle = await ensureSandbox(
        a,
        "sandbox-stop-install-e2e",
        fixture.bareDir,
      );
      const eventsUrl = `${url(a, "/_sandbox/events")}?handle=${encodeURIComponent(handle)}`;

      const installing = await readSseUntil(eventsUrl, {
        headers: jsonAuthHeaders(),
        predicate: (text) => text.includes('"phase":"installing"'),
        deadlineMs: 20_000,
      });
      expect(installing.res.status).toBe(200);

      const stopResponse = await fetch(url(a, "/_sandbox/setup/stop"), {
        method: "POST",
        headers: authHeaders({ "x-decocms-sandbox-handle": handle }),
      });
      expect(stopResponse.status).toBe(200);
      expect(await stopResponse.json()).toMatchObject({ stopped: true });

      // The killed install generation must never fall through to its Start
      // leg after Stop has acknowledged it.
      await sleep(1_000);
      expect(
        (await listTasks(a, handle)).some(
          (task) => task.logName === "dev" && task.status === "running",
        ),
      ).toBe(false);

      // Resume is another ensure. Because installation was interrupted, the
      // durable checkpoint chooses Install (not a blind Start); only after its
      // deterministic marker lands may the dev server appear.
      expect(
        await ensureSandbox(a, "sandbox-stop-install-e2e", fixture.bareDir),
      ).toBe(handle);
      await waitForFreshRunningTask(a, handle, "dev", new Set(), 30_000);
      const setupLogPath = join(
        sandboxDirFor(a.workdir, handle),
        "logs",
        "app",
        "setup",
      );
      expect(readFileSync(setupLogPath, "utf8")).toContain(
        "SLOW_INSTALL_COMPLETE",
      );
    }, 60_000);

    it("owner's exact sequence: establish -> kill -9 local-api -> relaunch same workdir -> headerless setup/start resurrects THE sandbox and its output streams on /_sandbox/events", async () => {
      const { workdir, fixtureRoot, handle, upstream } =
        await establishThenKill("headerless");
      cleanupDirs = [fixtureRoot, workdir];
      liveUpstream = upstream;

      // Relaunch against the SAME workdir — a fresh process, empty
      // in-memory `SandboxManager`, but the workdir/sidecar/logs survive.
      const b = await startLocalApi(
        stubClaudeBinEnv({
          DECOCMS_UPSTREAM_URL: upstream.url,
          LOCAL_API_TOKEN_STORE: "memory",
        }),
        { workdir },
      );
      liveApi = b;

      // Confirm the in-memory state really was forgotten (this is the
      // exact "meaningless global target" bug being reproduced/guarded):
      // a headerless GET of the repo-dir 404s because nothing is active
      // in memory YET (repo-dir deliberately never resurrects/falls back
      // to global — see routes/repo_dir.rs's own doc comment).
      const repoDirBefore = await fetch(url(b, "/_sandbox/repo-dir"), {
        headers: jsonAuthHeaders(),
      });
      expect(repoDirBefore.status).toBe(404);

      const before = await listTasks(b, handle);
      const beforeIds = new Set(before.map((t) => t.id));
      expect(before).toEqual([]);

      // The owner's reported click: headerless POST /_sandbox/setup/start
      // (the frontend's actual first attempt when `desktopSandboxHandle`
      // isn't known yet, or after dropping a stale handle).
      const startRes = await fetch(url(b, "/_sandbox/setup/start"), {
        method: "POST",
        headers: jsonAuthHeaders(),
      });
      expect(startRes.status).toBe(200);
      expect(((await startRes.json()) as { enqueued: string }).enqueued).toBe(
        "start",
      );

      // A REAL, fresh "dev" task for THIS handle proves resurrection
      // actually restarted the sandbox's own dev server — not a no-op
      // against the unrelated process-global path.
      const fresh = await waitForFreshRunningTask(b, handle, "dev", beforeIds);
      expect(beforeIds.has(fresh.id)).toBe(false);

      // "its output streams on the SSE the drawer watches": a NEW,
      // headerless /_sandbox/events connection (exactly what the desktop
      // drawer opens, per `sandbox-events-context.tsx`) now resolves to
      // the resurrected sandbox — a lifecycle frame reaching "running"
      // AND a real log frame (the dev server's stdout) both arrive.
      const { text } = await readSseUntil(url(b, "/_sandbox/events"), {
        headers: jsonAuthHeaders(),
        predicate: (acc) =>
          acc.includes('"phase":"running"') && acc.includes("event: log"),
        deadlineMs: 20_000,
      });
      expect(text).toContain("event: lifecycle");
      expect(text).toContain('"phase":"running"');
      expect(text).toContain("event: log");

      // repo-dir now resolves too — full proof the sandbox is genuinely
      // back, not just a dev task floating with no tracked config.
      const repoDirAfter = await fetch(url(b, "/_sandbox/repo-dir"), {
        headers: jsonAuthHeaders(),
      });
      expect(repoDirAfter.status).toBe(200);
      const repoDirBody = (await repoDirAfter.json()) as { repoDir: string };
      expect(repoDirBody.repoDir).toBe(repoDirFor(workdir, handle));
    }, 45_000);

    it("an EXPLICIT (stale, pre-restart) handle also resurrects on the first attempt — no frontend round-trip needed", async () => {
      const { workdir, fixtureRoot, handle, upstream } =
        await establishThenKill("explicit-handle");
      cleanupDirs = [fixtureRoot, workdir];
      liveUpstream = upstream;

      const b = await startLocalApi(
        stubClaudeBinEnv({
          DECOCMS_UPSTREAM_URL: upstream.url,
          LOCAL_API_TOKEN_STORE: "memory",
        }),
        { workdir },
      );
      liveApi = b;

      // This is exactly the frontend's FIRST attempt in `restart()`
      // (`sandbox-lifecycle-context.tsx`): attach the handle it already
      // has in React state (which outlives the backend process). Before
      // this fix this 404'd ("unknown sandbox handle") because the
      // in-memory SandboxManager forgot it; it must now succeed directly.
      const res = await fetch(url(b, "/_sandbox/setup/start"), {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          "x-decocms-sandbox-handle": handle,
        }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { enqueued: string }).enqueued).toBe(
        "start",
      );

      await waitForFreshRunningTask(b, handle, "dev", new Set());
    }, 45_000);

    it("an explicit handle with NO sidecar (never ensure()-d in ANY lifetime) is still a loud 404, never a silent success", async () => {
      const a = await startLocalApi(stubClaudeBinEnv());
      liveApi = a;
      const res = await fetch(url(a, "/_sandbox/setup/start"), {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          "x-decocms-sandbox-handle": "not-a-real-handle",
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not-a-real-handle");
    }, 30_000);

    it("headerless setup/start on a process that never persisted an active handle still 200s the byte-parity global path (no regression)", async () => {
      const a = await startLocalApi(stubClaudeBinEnv());
      liveApi = a;
      const res = await fetch(url(a, "/_sandbox/setup/start"), {
        method: "POST",
        headers: jsonAuthHeaders(),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { enqueued: string }).enqueued).toBe(
        "start",
      );
    }, 30_000);

    it("setup/stop kills the running dev task without respawning it", async () => {
      const fixture = setupFixtureRepo();
      const upstream = startAuthenticatedUpstream();
      liveUpstream = upstream;
      const virtualMcpId = "sandbox-restart-e2e-stop";
      const handle = computeHandle(fixture.bareDir, "main");
      const a = await startLocalApi(
        stubClaudeBinEnv({
          DECOCMS_UPSTREAM_URL: upstream.url,
          LOCAL_API_TOKEN_STORE: "memory",
        }),
      );
      liveApi = a;
      cleanupDirs = [fixture.root];
      await signInAndCompleteSession(a);

      await dispatchTurn(
        a,
        "sandbox-restart-org",
        "thread-stop",
        virtualMcpId,
        fixture.bareDir,
        "main",
      );
      await waitForFreshRunningTask(a, handle, "dev", new Set());
      const runningCapture = await readSseUntil(
        `${url(a, "/_sandbox/events")}?handle=${encodeURIComponent(handle)}`,
        {
          headers: jsonAuthHeaders(),
          predicate: (text) => devPorts(text).length > 0,
          deadlineMs: 20_000,
        },
      );
      const runningPort = devPorts(runningCapture.text).at(-1)!;

      const stopRes = await fetch(url(a, "/_sandbox/setup/stop"), {
        method: "POST",
        headers: authHeaders({ "x-decocms-sandbox-handle": handle }),
      });
      expect(stopRes.status).toBe(200);
      const stopBody = (await stopRes.json()) as {
        stopped: boolean;
        killed: number;
      };
      expect(stopBody.stopped).toBe(true);
      expect(stopBody.killed).toBeGreaterThanOrEqual(1);

      // Stop evicts the process generation and its in-memory task summaries;
      // the externally observable contract is that the actual server dies.
      await expectPortClosed(runningPort);

      // Never respawned on its own — no NEW running "dev" task appears
      // (unlike `start`, `stop` must not kick off a fresh cascade).
      await sleep(1000);
      const after = await listTasks(a, handle);
      expect(
        after.some((t) => t.logName === "dev" && t.status === "running"),
      ).toBe(false);
    }, 30_000);

    it("setup/stop returns a 400 'nothing to stop' when no dev/start task is running", async () => {
      const a = await startLocalApi(stubClaudeBinEnv());
      liveApi = a;
      const res = await fetch(url(a, "/_sandbox/setup/stop"), {
        method: "POST",
        headers: jsonAuthHeaders(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("nothing to stop");
    }, 30_000);

    it("setup/stop with an explicit unknown handle is a 404, never a silent no-op", async () => {
      const a = await startLocalApi(stubClaudeBinEnv());
      liveApi = a;
      const res = await fetch(url(a, "/_sandbox/setup/stop"), {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          "x-decocms-sandbox-handle": "not-a-real-handle",
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not-a-real-handle");
    }, 30_000);

    it("setup/stop is idempotent for a durable sandbox after backend restart and never starts it", async () => {
      const { workdir, fixtureRoot, handle, upstream } =
        await establishThenKill("stop-no-resurrect");
      cleanupDirs = [fixtureRoot, workdir];
      liveUpstream = upstream;
      const b = await startLocalApi(
        stubClaudeBinEnv({
          DECOCMS_UPSTREAM_URL: upstream.url,
          LOCAL_API_TOKEN_STORE: "memory",
        }),
        { workdir },
      );
      liveApi = b;

      const res = await fetch(url(b, "/_sandbox/setup/stop"), {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          "x-decocms-sandbox-handle": handle,
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        stopped: true,
        killed: 0,
        alreadyStopped: true,
        handle,
      });

      // The durable SQLite row lets Stop acknowledge the already-stopped
      // sandbox truthfully without materializing or starting its processes.
      await sleep(1500);
      const tasks = await listTasks(b, handle);
      expect(tasks.length).toBe(0);
    }, 45_000);
  },
);

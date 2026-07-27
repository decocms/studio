/**
 * local-api e2e: setup pipeline log retention — the clone-output-regression
 * fix (`setup/clone.rs`) and the file-backed `LogStore` (`crate::log_store`)
 * that replaced the old in-RAM per-task/per-source ring buffers.
 *
 * Drives the REAL `local-api` binary (via `LOCAL_API_E2E_CMD`, see
 * `helpers.ts`) against a REAL local `file://`-style bare-repo git fixture
 * (no network) — the same convention `git-sandbox.e2e.test.ts` uses —
 * bootstrapping via `POST /_sandbox/config` (classified as a `"bootstrap"`
 * transition -> `Step::Clone`, which `setup/mod.rs::run_cascade` chains into
 * install -> start).
 *
 * Proves, over HTTP + real files only (no Rust-internal access):
 *   (1) a client ALREADY connected to `/_sandbox/events` before the clone
 *       starts receives a LIVE `event: log` frame (source `"setup"`)
 *       carrying real `git clone` subprocess output WHILE the clone is in
 *       flight — the regression `setup/clone.rs`'s rewrite fixes (previously
 *       `run_git` shelled out via `Command::output()`, which buffers the
 *       whole process and returns only after exit — no task, no "log" frame,
 *       ever, for an in-progress clone);
 *   (2) a FRESH `/_sandbox/events` connection opened AFTER the pipeline
 *       settles replays ONE combined `"setup"` transcript containing BOTH
 *       the clone's `git clone` command line AND the install step's own
 *       output — proving the two steps interleave into the SAME file-backed
 *       source, not two separate ones;
 *   (3) the on-disk files backing that transcript actually exist under the
 *       app's workdir (`<workdir>/logs/app/setup`, `<workdir>/logs/tasks/*`)
 *       with the expected content — files are the source of truth, not RAM;
 *   (4) `GET /_sandbox/tasks/:id` and `GET /_sandbox/tasks/:id/stream` still
 *       correctly serve/replay a (now terminal) task's buffered output now
 *       that it's read from `LogStore` instead of an in-RAM ring buffer.
 *
 * Rotation/cap behavior (`LogStore`'s 10MB write cap + rotation marker) is
 * NOT re-exercised here — `log_store::store` already unit-tests that
 * directly against a tiny cap (`append_rotates_at_cap_with_a_marker_line`);
 * doing it here would mean pushing tens of MB through a real subprocess pipe
 * just to prove the same arithmetic a Rust unit test already covers cheaply.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import { sleep } from "@decocms/shared/std";
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  readSseUntil,
  startLocalApi,
  stopLocalApi,
  url,
  type LocalApi,
} from "./helpers";

/** Deterministic marker the install step's REAL subprocess (`bun install`)
 *  prints via a `postinstall` lifecycle script — lets this suite assert on
 *  install output without depending on any package manager's exact banner
 *  text (which varies by version). */
const INSTALL_MARKER = "INSTALL_MARKER_LOG_STORE_E2E";

function git(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr || res.stdout}`,
    );
  }
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * A bare "origin" with a single `main` commit carrying a `package.json`
 * whose `postinstall` script echoes `INSTALL_MARKER`. No `dev`/`start`
 * script on purpose: the `start` cascade step (port-sniffed dev server) is
 * already covered by `git-sandbox.e2e.test.ts`; this fixture only needs to
 * exercise clone + install so the setup pipeline settles at `start-failed`
 * (diagnosed, not an error) without spawning a long-lived process.
 */
function setupFixtureRepo(): { root: string; bareDir: string } {
  const root = mkdtempSync(join(tmpdir(), "log-store-e2e-"));
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "author");
  git(root, ["init", "--bare", "-q", bareDir]);
  git(root, ["init", "-q", "-b", "main", workDir]);
  git(workDir, ["config", "user.name", "Test User"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({
      name: "log-store-e2e-fixture",
      private: true,
      scripts: { postinstall: `echo ${INSTALL_MARKER}` },
    }),
  );
  git(workDir, ["add", "."]);
  git(workDir, ["commit", "-q", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", bareDir]);
  git(workDir, ["push", "-q", "-u", "origin", "main"]);
  git(bareDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, bareDir };
}

/** Polls `GET /_sandbox/config` until the setup orchestrator's
 *  `{running,pending}` both go quiet — the clone -> install -> start
 *  cascade has fully settled (byte-parity in spirit with both e2e helper
 *  files' own `waitForOrchestratorIdle` conventions). */
async function waitForOrchestratorIdle(
  a: LocalApi,
  deadlineMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const res = await fetch(url(a, "/_sandbox/config"), {
      headers: jsonAuthHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orchestrator: { running: boolean; pending: number };
    };
    if (!body.orchestrator.running && body.orchestrator.pending === 0) return;
    await sleep(200);
  }
  throw new Error(`orchestrator never went idle within ${deadlineMs}ms`);
}

/** Parses the first `event: log` frame out of accumulated SSE text into its
 *  `{source, data}` payload — both the live-connect and fresh-replay
 *  assertions below need to inspect the actual JSON, not just substring
 *  presence. */
function firstLogFrame(acc: string): { source: string; data: string } | null {
  const start = acc.indexOf("event: log");
  if (start < 0) return null;
  const end = acc.indexOf("\n\n", start);
  const frame = end >= 0 ? acc.slice(start, end) : acc.slice(start);
  const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) return null;
  return JSON.parse(dataLine.slice("data:".length).trimStart()) as {
    source: string;
    data: string;
  };
}

describeLocalApi(
  "local-api e2e: setup pipeline log retention (file-backed LogStore)",
  () => {
    let a: LocalApi;
    let fixture: { root: string; bareDir: string };

    beforeAll(async () => {
      fixture = setupFixtureRepo();
      a = await startLocalApi();
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await stopLocalApi(a);
      rmSync(fixture.root, { recursive: true, force: true });
    }, HOOK_TIMEOUT_MS);

    it("streams clone output LIVE to an already-connected SSE client, then file-backs + replays the combined clone+install transcript for a late connect (tasks endpoints included)", async () => {
      // --- Connect to /_sandbox/events BEFORE anything is configured. The
      // connect-time snapshot this request computes (inside the handler,
      // before its headers are even sent) is built while `state.tasks` has
      // no "setup" entry yet -- so ANY "log"/source":"setup" frame that
      // later arrives on THIS SAME connection is necessarily a LIVE
      // broadcast, not a replay -- structural proof, not a timing guess.
      const preCtrl = new AbortController();
      const preRes = await fetch(url(a, "/_sandbox/events"), {
        headers: jsonAuthHeaders(),
        signal: preCtrl.signal,
      });
      expect(preRes.status).toBe(200);
      const preReader = preRes.body!.getReader();
      const preDecoder = new TextDecoder();

      // --- NOW trigger the bootstrap -> clone -> install -> start cascade.
      const configRes = await fetch(url(a, "/_sandbox/config"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          git: { repository: { cloneUrl: fixture.bareDir, branch: "main" } },
          application: { packageManager: { name: "bun" } },
        }),
      });
      expect(configRes.status).toBe(200);
      const configBody = (await configRes.json()) as { transition: string };
      expect(configBody.transition).toBe("bootstrap");

      // --- Drain the ALREADY-OPEN stream until it carries a "log" frame
      // for source "setup" with real `git clone` subprocess output.
      let preAcc = "";
      const preDeadline = Date.now() + 20_000;
      while (Date.now() < preDeadline) {
        const { value, done } = await preReader.read();
        if (done) break;
        preAcc += preDecoder.decode(value, { stream: true });
        if (
          preAcc.includes('"source":"setup"') &&
          /\$ git .*clone/.test(preAcc)
        ) {
          break;
        }
      }
      const liveFrame = firstLogFrame(preAcc);
      expect(liveFrame).not.toBeNull();
      expect(liveFrame!.source).toBe("setup");
      // The `$ git ...` marker line `run_git` emits before every real git
      // subcommand -- proof this is streamed subprocess output, not a
      // canned string.
      expect(preAcc).toMatch(/\$ git .*clone/);

      preCtrl.abort();
      try {
        await preReader.cancel();
      } catch {
        /* already closed */
      }

      // --- Let the cascade fully settle before asserting terminal state.
      await waitForOrchestratorIdle(a);
      expect(existsSync(join(a.workdir, "repo", ".git"))).toBe(true);

      // --- A FRESH connection opened AFTER everything settled replays ONE
      // combined "setup" transcript with BOTH clone and install content.
      const { res: replayRes, text: replayText } = await readSseUntil(
        url(a, "/_sandbox/events"),
        {
          headers: jsonAuthHeaders(),
          predicate: (acc) => acc.includes('"source":"setup"'),
          deadlineMs: 5000,
        },
      );
      expect(replayRes.status).toBe(200);
      const replayFrame = firstLogFrame(replayText);
      expect(replayFrame).not.toBeNull();
      expect(replayFrame!.source).toBe("setup");
      expect(replayFrame!.data).toMatch(/\$ git .*clone/);
      expect(replayFrame!.data).toContain(INSTALL_MARKER);

      // --- The on-disk file backing that transcript actually exists, with
      // the expected content -- files are the source of truth, not RAM.
      const appSetupPath = join(a.workdir, "logs", "app", "setup");
      expect(existsSync(appSetupPath)).toBe(true);
      const onDisk = readFileSync(appSetupPath, "utf8");
      expect(onDisk).toMatch(/\$ git .*clone/);
      expect(onDisk).toContain(INSTALL_MARKER);

      // --- The tasks family: locate the clone + install "setup" tasks,
      // confirm their OWN per-task files exist on disk, and that
      // GET /_sandbox/tasks/:id and /_sandbox/tasks/:id/stream both still
      // correctly serve/replay a terminal task's output now that it's
      // file-backed instead of an in-RAM ring buffer.
      const tasksRes = await fetch(url(a, "/_sandbox/tasks"), {
        headers: jsonAuthHeaders(),
      });
      expect(tasksRes.status).toBe(200);
      const { tasks } = (await tasksRes.json()) as {
        tasks: Array<{
          id: string;
          command: string;
          logName?: string;
          status: string;
        }>;
      };
      const setupTasks = tasks.filter((t) => t.logName === "setup");
      expect(setupTasks.length).toBeGreaterThanOrEqual(2); // clone + install
      const cloneTask = setupTasks.find((t) => t.command.includes("clone"));
      const installTask = setupTasks.find((t) => t.command.includes("install"));
      expect(cloneTask).toBeDefined();
      expect(installTask).toBeDefined();
      expect(installTask!.status).toBe("exited");

      const taskLogsRoot = join(a.workdir, "logs", "tasks");
      const taskOutCandidates = filesUnder(taskLogsRoot).filter(
        (path) => basename(path) === `${installTask!.id}.out`,
      );
      expect(taskOutCandidates).toHaveLength(1);
      const taskOutPath = taskOutCandidates[0];
      expect(taskOutPath).toBeDefined();
      if (!taskOutPath) {
        throw new Error("install task output file is missing");
      }
      const taskOutRelative = relative(taskLogsRoot, taskOutPath);
      expect(isAbsolute(taskOutRelative)).toBe(false);
      expect(
        taskOutRelative === ".." || taskOutRelative.startsWith(`..${sep}`),
      ).toBe(false);
      expect(taskOutRelative.split(sep)).toHaveLength(2);
      expect(
        realpathSync(taskOutPath).startsWith(
          `${realpathSync(taskLogsRoot)}${sep}`,
        ),
      ).toBe(true);
      expect(readFileSync(taskOutPath, "utf8")).toContain(INSTALL_MARKER);

      const getRes = await fetch(url(a, `/_sandbox/tasks/${installTask!.id}`), {
        headers: jsonAuthHeaders(),
      });
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { stdout: string };
      expect(getBody.stdout).toContain(INSTALL_MARKER);

      const { res: streamRes, text: streamText } = await readSseUntil(
        url(a, `/_sandbox/tasks/${installTask!.id}/stream`),
        {
          headers: jsonAuthHeaders(),
          predicate: (acc) => acc.includes("event: end"),
          deadlineMs: 10_000,
        },
      );
      expect(streamRes.status).toBe(200);
      expect(streamText).toContain(INSTALL_MARKER);
      expect(streamText).toContain("event: end");
    }, 60_000);
  },
);

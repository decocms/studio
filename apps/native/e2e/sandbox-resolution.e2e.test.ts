/**
 * Black-box verification for two closely-related per-handle sandbox
 * resolution fixes (see
 * the native desktop-runtime audit findings #1/#4):
 *
 *   (a) `GET /_sandbox/repo-dir` (NEW route, `routes/repo_dir.rs`) — resolves
 *       a git-backed sandbox's absolute workdir by explicit handle header or,
 *       headerless, by the process's ACTIVE sandbox; 404 when neither
 *       resolves (never falls back to the unrelated process-global
 *       `repo_dir`).
 *   (b) `POST /_sandbox/setup/start` (`routes/setup.rs`) — a HEADERLESS
 *       request rides the pre-existing `handle -> active() -> global`
 *       fallback (byte-parity requires this to always `200` even with
 *       nothing dispatched, pinned separately below); an EXPLICIT but
 *       UNKNOWN handle header is now a `404`, not a silent restart of the
 *       unrelated global orchestrator.
 *
 * Drives the REAL `local-api` binary (via `LOCAL_API_E2E_CMD`, see
 * `helpers.ts`) against a REAL local `file://`-style bare-repo git fixture —
 * mirrors `git-sandbox.e2e.test.ts`'s fixture conventions.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sleep } from "@decocms/shared/std";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { computeHandle, normalizeBranch, repoDirFor } from "./sandbox-handle";

import {
  signInAndCompleteSession,
  startAuthenticatedUpstream,
} from "./authenticated-upstream";
import {
  authHeaders,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
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
  name: "sandbox-resolution-fixture",
  private: true,
  scripts: { dev: "node server.js" },
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
function setupFixtureRepo(): { root: string; bareDir: string } {
  const root = mkdtempSync(join(tmpdir(), "sandbox-resolution-e2e-"));
  const bareDir = join(root, "origin.git");
  const workDir = join(root, "author");
  git(root, ["init", "--bare", "-q", bareDir]);
  git(root, ["init", "-q", "-b", "main", workDir]);
  git(workDir, ["config", "user.name", "Test User"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(workDir, "package.json"), PACKAGE_JSON);
  writeFileSync(join(workDir, "server.js"), SERVER_JS);
  git(workDir, ["add", "."]);
  git(workDir, ["commit", "-q", "-m", "initial"]);
  git(workDir, ["remote", "add", "origin", bareDir]);
  git(workDir, ["push", "-q", "-u", "origin", "main"]);
  git(bareDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, bareDir };
}

/** Dispatches one turn on `(virtualMcpId, branch)`, driving
 * `SandboxManager::ensure` (clone + install + start cascade) exactly like a
 * real chat turn would — the stub harness's `SCENARIO:simple` needs no
 * filesystem side effects, just a normal completed turn. */
async function dispatchTurn(
  a: LocalApi,
  org: string,
  threadId: string,
  virtualMcpId: string,
  cloneUrl: string,
  branch: string,
  requestedHarnessId = "claude-code",
): Promise<string> {
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
        harnessId: requestedHarnessId,
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
  return streamRes.text();
}

interface TaskSummary {
  id: string;
  command: string;
  status: string;
  logName: string | null;
}

function parseUiChunks(raw: string): Record<string, unknown>[] {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null,
    );
}

/** `GET /_sandbox/tasks` scoped to `handle` via the header (or the
 * process-global registry when `handle` is omitted). */
async function listTasks(a: LocalApi, handle?: string): Promise<TaskSummary[]> {
  const res = await fetch(url(a, "/_sandbox/tasks"), {
    headers: authHeaders(handle ? { "x-decocms-sandbox-handle": handle } : {}),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tasks: TaskSummary[] };
  return body.tasks;
}

/** Polls `listTasks(a, handle)` until a RUNNING task named `logName` with an
 * id different from every id in `excludeIds` shows up — proves a fresh
 * dev-server task was spawned for THAT specific handle. */
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

describeLocalApi(
  "local-api e2e: sandbox handle resolution (repo-dir + setup/start)",
  () => {
    let a: LocalApi;
    let fixture: { root: string; bareDir: string };
    let upstream: ReturnType<typeof startAuthenticatedUpstream>;
    const virtualMcpId = "sandbox-resolution-e2e-vmcp";
    let handle: string;

    beforeAll(async () => {
      fixture = setupFixtureRepo();
      handle = computeHandle(fixture.bareDir, normalizeBranch("main"));
      upstream = startAuthenticatedUpstream();
      a = await startLocalApi(
        stubClaudeBinEnv({
          DECOCMS_UPSTREAM_URL: upstream.url,
          LOCAL_API_TOKEN_STORE: "memory",
          // The first turn pins Claude. A later request deliberately asks for
          // Codex; the durable SQLite pin must win before binary resolution,
          // so this nonexistent override must never be touched.
          LOCAL_API_CODEX_BIN: join(fixture.root, "missing-codex"),
        }),
      );
      await signInAndCompleteSession(a);
      await dispatchTurn(
        a,
        "sandbox-resolution-org",
        "thread-main",
        virtualMcpId,
        fixture.bareDir,
        "main",
      );
      // `ensure()` returns once clone/checkout are done but install+start
      // cascade asynchronously — wait for the dev server to actually be
      // registered as a running task before any test depends on it.
      await waitForFreshRunningTask(a, handle, "dev", new Set());
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await stopLocalApi(a);
      upstream.server.stop(true);
      rmSync(fixture.root, { recursive: true, force: true });
    }, HOOK_TIMEOUT_MS);

    it("GET /_sandbox/repo-dir with the handle header returns that sandbox's absolute workdir", async () => {
      const res = await fetch(url(a, "/_sandbox/repo-dir"), {
        headers: authHeaders({ "x-decocms-sandbox-handle": handle }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { repoDir: string };
      expect(body.repoDir).toBe(repoDirFor(a.workdir, handle));
    });

    it("reuses the durable harness and sandbox fast path while streaming native run status", async () => {
      const before = await listTasks(a, handle);
      const gitTasksBefore = before.filter((task) =>
        task.command.startsWith("git "),
      ).length;

      const raw = await dispatchTurn(
        a,
        "sandbox-resolution-org",
        "thread-main",
        virtualMcpId,
        fixture.bareDir,
        "main",
        "codex",
      );
      const chunks = parseUiChunks(raw);
      expect(
        chunks
          .filter((chunk) => chunk.type === "data-run-status")
          .map((chunk) => (chunk.data as { stage?: unknown }).stage),
      ).toEqual([
        "starting-run",
        "gathering-context",
        "preparing-tools",
        "starting-assistant",
      ]);
      expect(
        chunks
          .filter((chunk) => chunk.type === "text-delta")
          .map((chunk) => chunk.delta)
          .join(""),
      ).toBe("Hello from stub-harness");

      const after = await listTasks(a, handle);
      const gitTasksAfter = after.filter((task) =>
        task.command.startsWith("git "),
      ).length;
      expect(gitTasksAfter).toBe(gitTasksBefore);
    });

    it("GET /_sandbox/repo-dir headerless falls back to the ACTIVE sandbox", async () => {
      const res = await fetch(url(a, "/_sandbox/repo-dir"), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { repoDir: string };
      expect(body.repoDir).toBe(repoDirFor(a.workdir, handle));
    });

    it("GET /_sandbox/repo-dir with an unknown handle is a 404, never a guess", async () => {
      const res = await fetch(url(a, "/_sandbox/repo-dir"), {
        headers: authHeaders({
          "x-decocms-sandbox-handle": "not-a-real-handle",
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not-a-real-handle");
    });

    it("GET /_sandbox/repo-dir headerless is a 404 when NO sandbox has ever been dispatched (never the unrelated global repo_dir)", async () => {
      const fresh = await startLocalApi(stubClaudeBinEnv());
      try {
        const res = await fetch(url(fresh, "/_sandbox/repo-dir"), {
          headers: jsonAuthHeaders(),
        });
        expect(res.status).toBe(404);
      } finally {
        await stopLocalApi(fresh);
      }
    });

    it("POST /_sandbox/setup/start headerless restarts the ACTIVE sandbox's own dev server, not the process-global one", async () => {
      const before = await listTasks(a, handle);
      const beforeIds = new Set(before.map((t) => t.id));

      const res = await fetch(url(a, "/_sandbox/setup/start"), {
        method: "POST",
        headers: jsonAuthHeaders(),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { enqueued: string }).enqueued).toBe(
        "start",
      );

      // A brand-new "dev" task shows up in HANDLE's own registry — proves
      // the headerless request rode the active-handle fallback, not the
      // unrelated process-global orchestrator.
      const fresh = await waitForFreshRunningTask(a, handle, "dev", beforeIds);
      expect(beforeIds.has(fresh.id)).toBe(false);
    }, 30_000);

    it("POST /_sandbox/setup/start with an explicit UNKNOWN handle is a 404, not a silent restart of the wrong (global) target", async () => {
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
    });

    it('byte-parity guard: POST /_sandbox/setup/start headerless on a FRESH instance (nothing ever dispatched) is still 200 { enqueued: "start" } — never regress the pinned daemon.git.e2e.test.ts "setup routes" oracle', async () => {
      const fresh = await startLocalApi(stubClaudeBinEnv());
      try {
        const res = await fetch(url(fresh, "/_sandbox/setup/start"), {
          method: "POST",
          headers: jsonAuthHeaders(),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { enqueued: string }).enqueued).toBe(
          "start",
        );
      } finally {
        await stopLocalApi(fresh);
      }
    });
  },
);

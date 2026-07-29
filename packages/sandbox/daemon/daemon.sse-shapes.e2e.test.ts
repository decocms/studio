/**
 * Daemon conformance suite — SSE EVENT WIRE SHAPES.
 *
 * `daemon.e2e.test.ts` pins that /_sandbox/events streams *a* `status` frame
 * on connect; this file pins the wire shape (event name + `data:` JSON keys)
 * of every `DaemonEventMap` member — `status`, `lifecycle`, `branch`,
 * `tasks`, `scripts`, `file-changed`, `reload` — each triggered by a real
 * black-box HTTP/git/fs action against a running daemon, never by importing
 * `Broadcaster` or any other daemon source.
 *
 * Two triggering strategies, chosen per event:
 *
 *  - RECONNECT snapshot: `lifecycle`, `branch`, `tasks`, `scripts` and
 *    `status` are all re-emitted with their CURRENT value on every fresh
 *    SSE handshake (see `events/sse.ts`). Trigger the action, wait for it to
 *    land (`waitForOrchestratorIdle` or a matching poll), then open a NEW
 *    connection and read the handshake — no live-race with the trigger.
 *  - LIVE capture: `reload` and `file-changed` are transient — they are only
 *    ever broadcast to already-connected clients, never replayed on
 *    handshake. These open the SSE connection BEFORE the trigger and read
 *    live off the wire.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "bun:test";

import {
  authHeaders,
  bootstrapRepo,
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  readSseUntil,
  setupBareRepo,
  startDaemon,
  stopDaemon,
  url,
  waitForOrchestratorIdle,
  writeRepoFile,
} from "./daemon.e2e.helpers";

const SETUP_TIMEOUT_MS = 60_000;

let d: Daemon | null = null;
let repoCleanup: (() => void) | null = null;

afterEach(async () => {
  await stopDaemon(d);
  d = null;
  if (repoCleanup) {
    repoCleanup();
    repoCleanup = null;
  }
}, HOOK_TIMEOUT_MS);

// --- SSE frame parsing (test-side only; daemon wire format per sse-format.ts) -

interface SseEventFrame {
  event: string;
  data: string;
}

/** Split accumulated SSE text into complete `event:`/`data:` frames. */
function parseSseEvents(text: string): SseEventFrame[] {
  const out: SseEventFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (event && dataLines.length > 0)
      out.push({ event, data: dataLines.join("\n") });
  }
  return out;
}

/** JSON-parsed payloads for every `name` frame seen so far. A frame whose
 * `data:` line hasn't fully arrived yet (mid-chunk split) fails to parse and
 * is silently dropped — the next read() call re-scans the fuller buffer. */
function payloadsOf(text: string, name: string): unknown[] {
  const out: unknown[] = [];
  for (const f of parseSseEvents(text)) {
    if (f.event !== name) continue;
    try {
      out.push(JSON.parse(f.data));
    } catch {
      /* incomplete frame — ignore, a later read() will have the full text */
    }
  }
  return out;
}

function lastPayload(text: string, name: string): unknown {
  const all = payloadsOf(text, name);
  if (all.length === 0) {
    throw new Error(
      `no complete "${name}" event found; last 800 chars:\n${text.slice(-800)}`,
    );
  }
  return all[all.length - 1];
}

// --- Fixture: a bare repo whose `dev` script actually serves HTTP ------------

/**
 * Local variant of `daemon.e2e.helpers.ts`'s `setupBareRepo` — the shared
 * fixture's `withPackageJson` option only exposes an `echo` script (by
 * design: it must stay a no-op for every OTHER suite that uses it). Only the
 * `reload` test needs a script that binds a real port and announces it the
 * way vite/next do, so it's kept local rather than widening the shared
 * fixture's behavior for unrelated tests.
 */
function setupBareRepoWithDevServer(): {
  url: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "daemon-e2e-sse-repo-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const o = { stdio: "ignore" as const };
  const cfg =
    "-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false";
  execSync(`git ${cfg} init --bare ${bare}`, o);
  execSync(`git ${cfg} init ${seed}`, o);
  writeFileSync(join(seed, "README.md"), "hello\n");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify(
      {
        name: "fixture-dev-app",
        version: "0.0.0",
        private: true,
        scripts: {
          // Binds an ephemeral port and announces it the way vite/next do
          // ("Local: http://…") so the daemon's port-sniffer locks onto it
          // (see process/port-sniffer.ts) without a fixed-port collision risk.
          dev: "node -e \"const http=require('http');const s=http.createServer((_q,r)=>r.end('ok'));s.listen(0,()=>console.log('Local: http://localhost:'+s.address().port+'/'));\"",
        },
      },
      null,
      2,
    ),
  );
  execSync(`git ${cfg} -C ${seed} add .`, o);
  execSync(`git ${cfg} -C ${seed} commit -m initial`, o);
  execSync(`git ${cfg} -C ${seed} branch -M main`, o);
  execSync(`git ${cfg} -C ${seed} remote add origin ${bare}`, o);
  execSync(`git ${cfg} -C ${seed} push -u origin main`, o);
  execSync(`git ${cfg} -C ${bare} symbolic-ref HEAD refs/heads/main`, o);
  return {
    url: pathToFileURL(bare).href,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// --- status --------------------------------------------------------------

describe("daemon e2e: SSE wire shapes — status", () => {
  it("connect-time snapshot: { state, reason? }", async () => {
    d = await startDaemon();
    const { text } = await readSseUntil(url(d, "/_sandbox/events"), {
      headers: authHeaders(),
      predicate: (acc) => payloadsOf(acc, "status").length > 0,
    });
    const status = lastPayload(text, "status") as {
      state: string;
      reason?: string;
    };
    expect(status.state).toBe("running");
    // No unexpected keys on the wire, and `reason` (when present) is a string.
    expect(
      Object.keys(status).every((k) => k === "state" || k === "reason"),
    ).toBe(true);
    if ("reason" in status) expect(typeof status.reason).toBe("string");
  });
});

// --- file-changed (live capture, no repo needed) --------------------------

describe("daemon e2e: SSE wire shapes — file-changed", () => {
  it("writing a file emits { path } live to connected clients", async () => {
    d = await startDaemon();
    const ssePromise = readSseUntil(url(d, "/_sandbox/events"), {
      headers: authHeaders(),
      predicate: (acc) =>
        payloadsOf(acc, "file-changed").some(
          (p) => (p as { path?: string }).path === "sse-shape-probe.txt",
        ),
      // FILE_CHANGED_DEBOUNCE_MS (300ms) comfortably covers the SSE
      // connection setup racing the write below.
      deadlineMs: 8000,
    });
    await writeRepoFile(d, "sse-shape-probe.txt", "hi\n");
    const { text } = await ssePromise;
    const event = payloadsOf(text, "file-changed").find(
      (p) => (p as { path?: string }).path === "sse-shape-probe.txt",
    ) as { path: string };
    expect(event).toEqual({ path: "sse-shape-probe.txt" });
  });
});

// --- tasks (reconnect snapshot while a task is active) ---------------------

describe("daemon e2e: SSE wire shapes — tasks", () => {
  it("a running background task appears in the handshake's active array", async () => {
    d = await startDaemon();
    const spawnRes = await fetch(url(d, "/_sandbox/bash"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ command: "sleep 10", mode: "background" }),
    });
    expect(spawnRes.status).toBe(200);
    const { taskId } = (await spawnRes.json()) as { taskId: string };

    const { text } = await readSseUntil(url(d, "/_sandbox/events"), {
      headers: authHeaders(),
      predicate: (acc) => {
        const t = payloadsOf(acc, "tasks")[0] as
          | { active?: { id: string }[] }
          | undefined;
        return Boolean(t?.active?.some((task) => task.id === taskId));
      },
    });
    const tasks = lastPayload(text, "tasks") as {
      active: { id: string; command: string; logName?: string }[];
    };
    const active = tasks.active.find((t) => t.id === taskId);
    expect(active).toBeDefined();
    expect(active!.command).toBe("sleep 10");
  });
});

// --- lifecycle + branch + scripts (one clone, reconnect snapshot) ----------

describe("daemon e2e: SSE wire shapes — lifecycle, branch, scripts", () => {
  it(
    "cloning a repo with no start script drives all three to a terminal, coherent state",
    async () => {
      d = await startDaemon();
      const bare = setupBareRepo();
      repoCleanup = bare.cleanup;

      const res = await bootstrapRepo(d, bare.url, {
        application: { packageManager: { name: "npm" } },
      });
      expect(res.status).toBe(200);
      await waitForOrchestratorIdle(d, SETUP_TIMEOUT_MS);

      const { text } = await readSseUntil(url(d, "/_sandbox/events"), {
        headers: authHeaders(),
        predicate: (acc) => payloadsOf(acc, "scripts").length > 0,
        deadlineMs: 10_000,
      });

      const lifecycle = lastPayload(text, "lifecycle") as {
        state: { phase: string; error?: string };
      };
      expect(lifecycle.state.phase).toBe("start-failed");
      expect(typeof lifecycle.state.error).toBe("string");

      const branch = lastPayload(text, "branch") as {
        meta: {
          kind: string;
          branch?: string;
          base?: string;
          workingTreeDirty?: boolean;
          unpushed?: number;
          aheadOfBase?: number;
          behindBase?: number;
          headSha?: string;
        };
      };
      expect(branch.meta.kind).toBe("ready");
      expect(branch.meta.branch).toBe("main");
      expect(typeof branch.meta.workingTreeDirty).toBe("boolean");
      expect(typeof branch.meta.headSha).toBe("string");

      const scripts = lastPayload(text, "scripts") as { scripts: string[] };
      expect(scripts).toEqual({ scripts: [] });
    },
    SETUP_TIMEOUT_MS,
  );
});

// --- reload (live capture — needs a real dev server to come online) --------

describe("daemon e2e: SSE wire shapes — reload", () => {
  // Windows: the fixture's dev script is an inline `node -e "...'...'..."`,
  // whose nested single quotes do not survive cmd.exe quoting, so the dev
  // server never binds and the run only ever reaches `start-failed`. That is
  // the FIXTURE's portability limit, not the daemon's — every other lifecycle
  // shape in this file is asserted cross-platform. Same treatment as the
  // SIGTERM case in daemon.git.e2e.test.ts.
  it.skipIf(process.platform === "win32")(
    "dev server coming online after 'starting' emits reload:{} and lifecycle:running",
    async () => {
      const repo = setupBareRepoWithDevServer();
      repoCleanup = repo.cleanup;
      d = await startDaemon();

      // Connect BEFORE the trigger — `reload` is live-only, never replayed.
      const ssePromise = readSseUntil(url(d, "/_sandbox/events"), {
        headers: authHeaders(),
        predicate: (acc) => payloadsOf(acc, "reload").length > 0,
        deadlineMs: SETUP_TIMEOUT_MS,
      });

      const res = await bootstrapRepo(d, repo.url, {
        application: { packageManager: { name: "npm" } },
      });
      expect(res.status).toBe(200);

      const { text } = await ssePromise;
      const reload = lastPayload(text, "reload");
      // DaemonEventMap["reload"] is `Record<string, never>` — the wire shape
      // is a bare `{}`.
      expect(reload).toEqual({});

      const runningLifecycles = payloadsOf(text, "lifecycle").filter(
        (p) => (p as { state: { phase: string } }).state.phase === "running",
      ) as { state: { phase: string; port: number; htmlSupport: boolean } }[];
      expect(runningLifecycles.length).toBeGreaterThan(0);
      const running = runningLifecycles[0]!;
      expect(typeof running.state.port).toBe("number");
      expect(typeof running.state.htmlSupport).toBe("boolean");
    },
    SETUP_TIMEOUT_MS,
  );
});

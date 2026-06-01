import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bumpActivity } from "./activity";
import { requireToken } from "./auth";
import { TenantConfigStore } from "./config-store";
import { REPLAY_BYTES } from "./constants";
import { Broadcaster } from "./events/broadcast";
import type { DaemonStatus } from "./events/types";
import { BranchStatusMonitor } from "./git/branch-status";
import { gitSync } from "./git/git-sync";
import { InstallState } from "./install/install-state";
import { LifecycleManager } from "./lifecycle/manager";
import { readConfig } from "./persistence";
import { createPortSniffer } from "./process/port-sniffer";
import { TaskManager } from "./process/task-manager";
import { PhaseManager } from "./process/phase-manager";
import { startUpstreamProbe } from "./probe";
import { makeProxyHandler } from "./proxy";
import { jsonResponse } from "./routes/body-parser";
import { makeBashHandler } from "./routes/bash";
import {
  makeGitDiffHandler,
  makeGitDiscardHandler,
  makeGitPublishHandler,
  makeGitRebaseHandler,
  makeGitStatusHandler,
} from "./routes/git";
import {
  makeConfigReadHandler,
  makeConfigUpdateHandler,
} from "./routes/config";
import { handleCancelRequest, handleDispatchRequest } from "./routes/dispatch";
// Import CLI factories from their subpaths (rather than the barrel
// `apps/mesh/src/harnesses/index.ts`) to avoid pulling in the cluster-only
// `decopilotHarnessFactory` and its dependency tree (which references
// `@/...` path aliases that only exist under apps/mesh).
import { claudeCodeHarnessFactory } from "../../../apps/mesh/src/harnesses/claude-code";
import { codexHarnessFactory } from "../../../apps/mesh/src/harnesses/codex";
import type {
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../../../apps/mesh/src/harnesses/types";
import { metrics, trace } from "@opentelemetry/api";
import { makeEventsHandler } from "./routes/events-stream";
import { makeExecHandler } from "./routes/exec";
import {
  makeReadHandler,
  makeWriteHandler,
  makeUnlinkHandler,
  makeEditHandler,
  makeGrepHandler,
  makeGlobHandler,
  makeWriteFromUrlHandler,
  makeUploadToUrlHandler,
} from "./routes/fs";
import { makeHealthHandler } from "./routes/health";
import { makeIdleHandler } from "./routes/idle";
import { makeSetupHandler } from "./routes/setup";
import {
  makeTasksDeleteHandler,
  makeTasksGetHandler,
  makeTasksKillAllHandler,
  makeTasksKillHandler,
  makeTasksListHandler,
  makeTasksStreamHandler,
} from "./routes/tasks";
import { makeScriptsHandler } from "./routes/scripts";
import { discoverScripts } from "./process/script-discovery";
import { SetupOrchestrator } from "./setup/orchestrator";
import type { Config, TenantConfig } from "./types";
import { makeWsUpgrader, type WsProxyData } from "./ws-proxy";

if (!process.env.DAEMON_BOOT_ID) {
  process.env.DAEMON_BOOT_ID = randomUUID();
}

// Corepack walks UP from cwd to find the closest `packageManager` field and
// rejects mismatched invocations. On host runners the daemon's workdir lives
// under the user's home, so an unrelated ancestor (e.g. `~/package.json`) can
// hijack `yarn`/`npm` calls in the cloned repo. Setting STRICT=0 lets corepack
// run whichever PM the daemon picked, regardless of what an ancestor declared.
process.env.COREPACK_ENABLE_STRICT = "0";

const APP_ROOT = process.env.WORKDIR ?? process.env.APP_ROOT ?? "/";
const resolvedDaemonPort =
  process.env.DAEMON_PORT ?? process.env.PROXY_PORT ?? "9000";
process.env.DAEMON_PORT = resolvedDaemonPort;
const bootConfig = {
  daemonToken: process.env.DAEMON_TOKEN ?? "",
  daemonBootId: process.env.DAEMON_BOOT_ID ?? "",
  appRoot: APP_ROOT,
  repoDir: join(APP_ROOT, "repo"),
  proxyPort: parseInt(resolvedDaemonPort, 10),
};
// Ensure repoDir exists so bash commands with the default cwd don't fail with
// ENOENT when no repo has been cloned yet (tool-only sandboxes, no-repo agents).
mkdirSync(bootConfig.repoDir, { recursive: true });
// Workspace layout: <appRoot>/repo (cloned source), <appRoot>/tmp/{app,taskN}
// (log tees). Everything inside appRoot is reachable by fs/bash routes
// (clamped to appRoot).
const TMP_DIR = join(APP_ROOT, "tmp");

const broadcaster = new Broadcaster(REPLAY_BYTES);

// `application.port` is what mesh told the dev script to use, but plenty of
// frameworks (vite included) ignore PORT env and pick their own — and on the
// host runner two sandboxes can race for the same default port, leaving the
// loser on a fallback. Sniff the actual bind announcement from starter
// stdout and feed THAT to the probe; the configured port stays as a
// fallback for tools that do honor PORT.
const portSniffer = createPortSniffer();
const broadcastChunkRaw = broadcaster.broadcastChunk.bind(broadcaster);
broadcaster.broadcastChunk = (source, data, opts) => {
  portSniffer.observe(source, data);
  broadcastChunkRaw(source, data, opts);
};

let currentStatus: DaemonStatus = { state: "running" };
function setStatus(next: DaemonStatus) {
  currentStatus = next;
  broadcaster.emit("status", next);
}

const store = new TenantConfigStore();
const installState = new InstallState();
const lifecycle = new LifecycleManager({ broadcaster });
let resetProbeState = (): void => {};
// Drop the sniffed port whenever we leave `running` — the next dev start
// may bind somewhere else and we need to re-sniff its announcement.
const lifecycleTransitionRaw = lifecycle.transition.bind(lifecycle);
lifecycle.transition = (next) => {
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  const prev = lifecycle.current().phase;
  const wasRunning = prev === "running";
  lifecycleTransitionRaw(next);
  if (wasRunning && next.phase !== "running") {
    portSniffer.reset();
    resetProbeState();
  }
  if (prev !== next.phase) {
    console.log(`[lifecycle] ${prev} → ${next.phase}`);
  }
};
// Per-command history for LLM context (each bash/exec spawned via TaskManager
// is tracked as a phase). Setup pipeline phases live on `lifecycle` instead.
const phaseManager = new PhaseManager();
const taskManager = new TaskManager({
  logsDir: TMP_DIR,
  phaseManager,
  broadcaster,
  onChange: () => {
    broadcaster.emit("tasks", { active: getActiveTasks() });
  },
});

// Per-chunk task output is silenced in pod logs (see broadcaster opt-out);
// surface exits explicitly so an operator can see "dev exited 1" without
// the firehose of stdout that preceded it.
taskManager.onTaskExit((s) => {
  const label = s.logName ?? s.id;
  console.log(`[task] ${label} ${s.status} (exit=${s.exitCode})`);
});

function getActiveTasks() {
  return taskManager
    .list({ status: ["running"] })
    .map((t) => ({ id: t.id, command: t.command, logName: t.logName }));
}
const branchStatus = new BranchStatusMonitor(
  {
    appRoot: bootConfig.appRoot,
    repoDir: bootConfig.repoDir,
    daemonToken: bootConfig.daemonToken,
    daemonBootId: bootConfig.daemonBootId,
    proxyPort: bootConfig.proxyPort,
    dropPrivileges: false,
  } as Config,
  broadcaster,
);

const orchestrator = new SetupOrchestrator({
  bootConfig: { appRoot: bootConfig.appRoot, repoDir: bootConfig.repoDir },
  store,
  taskManager,
  setStatus,
  getStatus: () => currentStatus,
  broadcaster,
  installState,
  logsDir: TMP_DIR,
  lifecycle,
  branchStatus,
});

store.subscribe((event) => {
  orchestrator.handle(event.transition);
});

// Probe transitions lifecycle from `starting` → `running` (dev server up)
// and `running` → `crashed` (was online, lost contact). Pre-running phases
// (cloning, installing, etc.) are owned by the orchestrator.
//
// Dirty-baseline: dev scripts often rewrite tracked files at boot (minified
// `static/tailwind.css`, compiled CSS, lockfile drift). The first
// `online` transition arms a noise baseline of those paths so the
// "Save changes" button doesn't flip on for boot-time noise. The 3 s grace
// gives common post-Ready writers (PostCSS/Tailwind JIT, Vite asset emit)
// time to land before we snapshot. `clearBaseline` on `crashed`/restart so
// a re-armed baseline reflects the new boot's noise.
const BASELINE_GRACE_MS = 3000;
let baselineTimer: ReturnType<typeof setTimeout> | null = null;
// Port we last confirmed the dev script was running on. Recovery key:
// when a transient HEAD failure marks us `crashed` and the server then
// comes back on the SAME port, it's almost certainly the same process
// recovering (vite/nodemon kept serving after a probe blip) — allow the
// transition back to `running`. A different port is ambiguous (could be a
// sibling sandbox on the same host) so we hold at `crashed` and require
// an explicit restart.
let lastRunningPort: number | null = null;
const lastProbe = startUpstreamProbe({
  getPort: () =>
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    portSniffer.current() ?? store.read()?.application?.port ?? null,
  onChange: (s) => {
    // The probe only honors a "port is responding" verdict when we
    // actually expect our dev script to be up — i.e. we're currently in
    // `starting` (just spawned, waiting for first response), already in
    // `running`, or recovering from a `crashed` on the same port.
    // Otherwise a sibling sandbox on the same host can resurrect us back
    // to `running` after the orchestrator has correctly recorded
    // `start-failed`/`crashed`, leaving the iframe pointed at some other
    // sandbox's app. Same logic mirrored on the offline edge: only mark
    // `crashed` when we were actually running, never as a side effect of
    // a port that was never ours in the first place.
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    const phase = lifecycle.current().phase;
    if (s.status === "online" && s.port !== null) {
      const isCrashedRecovery =
        phase === "crashed" && s.port === lastRunningPort;
      if (phase !== "starting" && phase !== "running" && !isCrashedRecovery) {
        return;
      }
      lastRunningPort = s.port;
      const wasDown = phase === "starting" || phase === "crashed";
      lifecycle.transition({
        phase: "running",
        port: s.port,
        htmlSupport: s.htmlSupport,
      });
      if (wasDown) broadcaster.emit("reload", {});
      if (!baselineTimer) {
        baselineTimer = setTimeout(() => {
          baselineTimer = null;
          branchStatus.armBaseline();
        }, BASELINE_GRACE_MS);
      }
    } else if (s.status === "offline") {
      if (phase !== "running") return;
      lifecycle.transition({ phase: "crashed" });
      // Dev script lost contact — next start may bind to a different port,
      // so unlock the sniffer to re-detect on the next bind announcement.
      // We deliberately do NOT clear `lastRunningPort` — it's the recovery
      // key checked above when the same port comes back online.
      portSniffer.reset();
      if (baselineTimer) {
        clearTimeout(baselineTimer);
        baselineTimer = null;
      }
      branchStatus.clearBaseline();
    }
  },
  onLog: (msg) => broadcaster.broadcastChunk("setup", msg),
});
resetProbeState = () => {
  lastProbe.status = "booting";
  lastProbe.port = null;
  lastProbe.htmlSupport = false;
};

// HTTP/WS proxy forwards to the same port the probe is HEAD-checking.
// `application.port` is what mesh configured, but vite/etc. routinely
// pick a fallback when the configured one is busy — using the sniffed
// announce-port keeps the proxy aligned with what the dev script
// actually bound to. Falls back to the configured value when nothing has
// been sniffed yet.
const getDevPort = (): number | null =>
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  portSniffer.current() ?? store.read()?.application?.port ?? null;
const { appRoot, repoDir } = bootConfig;
const fsDeps = {
  appRoot,
  repoDir,
  onWorkingTreeWrite: () => {
    if (process.env.DEBUG_SAVE_CHANGES === "1") {
      console.log("[branch-status] fs write/edit → refresh", { repoDir });
    }
    branchStatus.refresh();
  },
};
const readH = makeReadHandler(fsDeps);
const writeH = makeWriteHandler(fsDeps);
const unlinkH = makeUnlinkHandler(fsDeps);
const editH = makeEditHandler(fsDeps);
const grepH = makeGrepHandler(fsDeps);
const globH = makeGlobHandler(fsDeps);
const writeFromUrlH = makeWriteFromUrlHandler(fsDeps);
const uploadToUrlH = makeUploadToUrlHandler(fsDeps);

const bashH = makeBashHandler({
  repoDir,
  taskManager,
});
const gitDeps = { appRoot, repoDir };
const gitStatusH = makeGitStatusHandler(gitDeps);
const gitDiffH = makeGitDiffHandler(gitDeps);
const gitPublishH = makeGitPublishHandler(gitDeps);
const gitDiscardH = makeGitDiscardHandler(gitDeps);
const gitRebaseH = makeGitRebaseHandler(gitDeps);
const execH = makeExecHandler({
  repoDir,
  store,
  taskManager,
});

const tasksListH = makeTasksListHandler({ taskManager });
const tasksGetH = makeTasksGetHandler({ taskManager });
const tasksKillH = makeTasksKillHandler({ taskManager });
const tasksKillAllH = makeTasksKillAllHandler({ taskManager });
const tasksDeleteH = makeTasksDeleteHandler({ taskManager });
const tasksStreamH = makeTasksStreamHandler({ taskManager });

const scriptsHandler = makeScriptsHandler(() => {
  const cached = orchestrator.getDiscoveredScripts();
  if (cached) return cached;
  const enriched = store.read();
  const pm = enriched?.application?.packageManager?.name ?? null;
  const cwd = enriched?.application?.packageManager?.path ?? repoDir;
  if (!pm) return [];
  return discoverScripts(cwd, pm);
});

const setupCloneH = makeSetupHandler("clone", { orchestrator });
const setupInstallH = makeSetupHandler("install", { orchestrator });
const setupStartH = makeSetupHandler("start", { orchestrator });

// oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
const isReady = () => lifecycle.current().phase === "running";

const healthH = makeHealthHandler({
  config: { daemonBootId: process.env.DAEMON_BOOT_ID ?? "" },
  getReady: isReady,
  getOrchestrator: () => ({
    running: orchestrator.isRunning(),
    pending: orchestrator.pendingCount(),
  }),
  getConfigured: () => store.read() !== null,
});

const eventsH = makeEventsHandler({
  broadcaster,
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  getLifecycle: () => lifecycle.current(),
  getDiscoveredScripts: () => orchestrator.getDiscoveredScripts(),
  getActiveTasks,
  getStatus: () => currentStatus,
  getBranchMeta: () => branchStatus.getLast(),
});

const idleH = makeIdleHandler();
const proxyH = makeProxyHandler({ broadcaster, getDevPort });

// ─── Remote harness dispatch ───────────────────────────────────────────
// Authenticated by the bearer `bootConfig.daemonToken` (see `./auth`). The
// cluster's `remoteDispatch` posts a HarnessStreamInput here, proxied over
// loopback by the link daemon's control handler; the daemon spawns the
// named factory's CLI in-process and streams `UIMessageChunk` back as SSE.
//
// Only the CLI factories live in the daemon — decopilot pulls in
// cluster-only modules (RunRegistry, run-stream internals) and is never
// invoked over the wire.
const dispatchHarnessRegistry: Map<string, HarnessFactory> = new Map([
  ["claude-code", claudeCodeHarnessFactory],
  ["codex", codexHarnessFactory],
]);
const dispatchTracer = trace.getTracer("link-daemon");
const dispatchMeter = metrics.getMeter("link-daemon");
const lookupDispatchHarness = (id: string, input: unknown) => {
  const factory = dispatchHarnessRegistry.get(id);
  if (!factory) throw new Error(`unknown harness: ${id}`);
  // Build a minimal HarnessContext. CLI harnesses don't read storage,
  // db, vault, or aiProviders — they only need tracer/meter for OTel
  // and metadata for span attributes. The cluster's richer MeshContext
  // is structurally compatible with this shape (see
  // `apps/mesh/src/core/harness-context.ts`).
  const harnessInput = input as HarnessStreamInput;
  const ctx: HarnessContext = {
    tracer: dispatchTracer,
    meter: dispatchMeter,
    metadata: {
      threadId: harnessInput.threadId,
      orgId: harnessInput.organizationId,
      userId: harnessInput.user?.id,
    },
  };
  const harness = factory.create(ctx);
  return { stream: () => harness.stream(harnessInput) };
};
const wsProxy = makeWsUpgrader(getDevPort, { onClientMessage: bumpActivity });

const configReadH = makeConfigReadHandler({
  daemonBootId: process.env.DAEMON_BOOT_ID ?? "",
  store,
  getState: () => ({
    orchestrator: {
      running: orchestrator.isRunning(),
      pending: orchestrator.pendingCount(),
    },
    ready: isReady(),
  }),
  getTasks: () => phaseManager.recent(20),
});
// Closure mutates `bootConfig.daemonToken` in place so the
// `requireToken(req, bootConfig.daemonToken)` calls below — which read the
// property on each request — pick up the rotated value without any
// reload. The auth handler validates the rotation request against the
// *current* token; rotation happens only after that check passes, so a
// successful rotation is always an authenticated handoff.
const configUpdateH = makeConfigUpdateHandler({
  daemonBootId: process.env.DAEMON_BOOT_ID ?? "",
  store,
  setDaemonToken: (next) => {
    bootConfig.daemonToken = next;
    process.env.DAEMON_TOKEN = next;
  },
});

function hydrate(): void {
  const diskOutcome = readConfig(bootConfig.repoDir);
  if (diskOutcome.kind !== "valid") return;
  const initial: TenantConfig = diskOutcome.config;
  store.hydrate(initial);
  orchestrator.handle({ kind: "bootstrap", config: initial });
}

hydrate();

if (!store.read()) {
  console.log(
    `[daemon] boot_id=${process.env.DAEMON_BOOT_ID} ready, unclaimed — waiting for workload config`,
  );
}
// Reference to silence "unused" — keep for future probe-state introspection.
void lastProbe;

let firstWorkLogged = false;

// Canonical and legacy daemon route prefixes. The cluster speaks only
// `/_sandbox/*` (see T11 in 2026-05-22-sandbox-naming-uniformization.md);
// `/_decopilot_vm/*` is dual-served for one release window so old clusters
// rolling out keep working until they pick up the rename. Remove the
// legacy prefix in a follow-up release once all clusters and the
// housekeeper sweep script have updated.
const SANDBOX_PREFIX = "/_sandbox";
const LEGACY_SANDBOX_PREFIX = "/_decopilot_vm";
const SANDBOX_IDLE_PATH = `${SANDBOX_PREFIX}/idle`;
const LEGACY_SANDBOX_IDLE_PATH = `${LEGACY_SANDBOX_PREFIX}/idle`;

/**
 * If `pathname` is under one of the known sandbox prefixes, return the
 * prefix actually used plus the suffix. Otherwise `null`. Used by the
 * top-level fetch dispatcher and propagated into HMAC verification so
 * the daemon validates against the same prefix the cluster signed.
 */
function matchSandboxPrefix(
  pathname: string,
): { prefix: string; suffix: string } | null {
  for (const prefix of [SANDBOX_PREFIX, LEGACY_SANDBOX_PREFIX]) {
    if (pathname === prefix || pathname === `${prefix}/`) {
      return { prefix, suffix: "/" };
    }
    if (pathname.startsWith(`${prefix}/`)) {
      return { prefix, suffix: pathname.slice(prefix.length) };
    }
  }
  return null;
}

async function configH(req: Request, prefix: string): Promise<Response> {
  const { method } = req;
  if (method === "GET") return configReadH();
  if (method === "PUT" || method === "POST") return configUpdateH(req);
  return jsonResponse({ error: `Not found: ${prefix}/config` }, 404);
}

function tasksRouteH(
  req: Request,
  method: string,
  vmPath: string,
  prefix: string,
): Response | Promise<Response> {
  if (method === "GET" && vmPath === "/tasks") return tasksListH(req);
  if (method === "POST" && vmPath === "/tasks/kill-all") return tasksKillAllH();
  if (method === "GET" && /^\/tasks\/[^/]+\/stream$/.test(vmPath))
    return tasksStreamH(req);
  if (method === "POST" && /^\/tasks\/[^/]+\/kill$/.test(vmPath))
    return tasksKillH(req);
  if (method === "DELETE" && /^\/tasks\/[^/]+$/.test(vmPath))
    return tasksDeleteH(req);
  if (method === "GET" && /^\/tasks\/[^/]+$/.test(vmPath))
    return tasksGetH(req);
  return jsonResponse({ error: `Not found: ${prefix}${vmPath}` }, 404);
}

function execRouteH(
  req: Request,
  vmPath: string,
): Response | Promise<Response> {
  if (vmPath.endsWith("/kill")) {
    const rawName = vmPath.slice("/exec/".length, -"/kill".length);
    try {
      const name = decodeURIComponent(rawName);
      return jsonResponse({
        killed: taskManager.killByLogName(name, { intentional: true }),
      });
    } catch {
      return jsonResponse({ error: "invalid script name" }, 400);
    }
  }
  return execH(req);
}

const fsH: Record<string, (req: Request) => Response | Promise<Response>> = {
  "/read": readH,
  "/write": writeH,
  "/unlink": unlinkH,
  "/edit": editH,
  "/grep": grepH,
  "/glob": globH,
  "/write_from_url": writeFromUrlH,
  "/upload_to_url": uploadToUrlH,
  "/bash": bashH,
};

const gitH: Record<string, (req: Request) => Response | Promise<Response>> = {
  "/git/status": gitStatusH,
  "/git/diff": gitDiffH,
  "/git/publish": gitPublishH,
  "/git/discard": gitDiscardH,
  "/git/rebase": gitRebaseH,
};

const setupH: Record<string, () => Response> = {
  "/setup/clone": setupCloneH,
  "/setup/install": setupInstallH,
  "/setup/start": setupStartH,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Cache-Control, Authorization",
};

async function vmRouteH(
  req: Request,
  method: string,
  vmPath: string,
  prefix: string,
): Promise<Response> {
  if (method === "GET" && vmPath === "/idle") return idleH();
  if (method === "GET" && vmPath === "/events") return eventsH();
  if (method === "GET" && vmPath === "/scripts") return scriptsHandler();
  if (method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Harness dispatch + cancel read their own body, so keep them inline
  // (they run the bearer-token check themselves before parsing).
  if (method === "POST" && vmPath === "/dispatch") {
    return handleDispatchRequest(req, {
      daemonToken: bootConfig.daemonToken,
      lookupHarness: lookupDispatchHarness,
    });
  }
  if (method === "DELETE" && vmPath.startsWith("/runs/")) {
    return handleCancelRequest(req, {
      daemonToken: bootConfig.daemonToken,
    });
  }

  const denied = requireToken(req, bootConfig.daemonToken);
  if (denied) return denied;

  // Buffer body once and re-inject as a fresh Request for downstream
  // handlers that re-read it.
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";
  const body = hasBody ? await req.text() : "";

  const rebuilt = hasBody
    ? new Request(req.url, { method, headers: req.headers, body })
    : req;

  if (vmPath === "/config") return configH(rebuilt, prefix);
  if (vmPath.startsWith("/tasks"))
    return tasksRouteH(rebuilt, method, vmPath, prefix);
  if (method === "POST" && vmPath in setupH) return setupH[vmPath]();
  if (method === "GET" && vmPath in gitH) return gitH[vmPath](rebuilt);
  if (method === "POST" && vmPath in fsH) return fsH[vmPath](rebuilt);
  if (method === "POST" && vmPath in gitH) return gitH[vmPath](rebuilt);
  if (method === "POST" && vmPath.startsWith("/exec/"))
    return execRouteH(rebuilt, vmPath);

  return jsonResponse({ error: `Not found: ${prefix}${vmPath}` }, 404);
}

Bun.serve<WsProxyData, never>({
  port: bootConfig.proxyPort,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req, server) {
    const { pathname: p } = new URL(req.url);
    const { method } = req;

    if (
      p !== "/health" &&
      p !== SANDBOX_IDLE_PATH &&
      p !== LEGACY_SANDBOX_IDLE_PATH
    ) {
      bumpActivity();
      if (!firstWorkLogged) {
        firstWorkLogged = true;
        console.log(
          `[daemon] boot_id=${process.env.DAEMON_BOOT_ID} first request: METHOD=${method} PATH=${p}`,
        );
      }
    }

    const sandboxMatch = matchSandboxPrefix(p);

    if (
      req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
      !sandboxMatch
    ) {
      const ok = server.upgrade(req, { data: wsProxy.upgradeData(req) });
      return ok
        ? (undefined as unknown as Response)
        : new Response("Upgrade failed", { status: 400 });
    }

    if (method === "GET" && p === "/health") return healthH();
    if (sandboxMatch)
      return vmRouteH(req, method, sandboxMatch.suffix, sandboxMatch.prefix);
    return proxyH(req);
  },
  websocket: {
    open: wsProxy.open,
    message: wsProxy.message,
    close: wsProxy.close,
  },
});

process.on("SIGTERM", () => {
  taskManager.shutdown();
  branchStatus.stop();
  const branch = store.read()?.git?.repository?.branch;
  if (branch) {
    try {
      gitSync(["-c", "safe.directory=*", "add", "-A"], {
        cwd: bootConfig.repoDir,
      });
      gitSync(
        [
          "-c",
          "safe.directory=*",
          "commit",
          "-m",
          `chore(daemon): sync all local changes to remote on shutdown`,
        ],
        { cwd: bootConfig.repoDir },
      );
      gitSync(["-c", "safe.directory=*", "push", "origin", branch], {
        cwd: bootConfig.repoDir,
      });
    } catch {
      // best-effort
    }
  }
  process.exit(0);
});

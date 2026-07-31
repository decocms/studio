import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { sleep } from "@decocms/shared/std";
import { join } from "node:path";
import { bumpActivity } from "./activity";
import { requireToken } from "./auth";
import { TenantConfigStore } from "./config-store";
import { REPLAY_BYTES } from "./constants";
import { Broadcaster } from "./events/broadcast";
import type { DaemonStatus } from "./events/types";
import { BranchStatusMonitor } from "./git/branch-status";
import { InstallState } from "./install/install-state";
import { LifecycleManager } from "./lifecycle/manager";
import { readConfig } from "./persistence";
import { MountManager } from "./org-fs/mount-manager";
import { createRcloneMounter, detachMount } from "./org-fs/mounter";
import { parseOrgFsConfig } from "./org-fs/config";
import { repointOutputLink, repointUploadLink } from "./org-fs/thread-links";
import { ensureRepoOrgLink } from "./org-fs/repo-link";
import type { SidecarStatus } from "./org-fs/sidecar";
import { makeOrgFsConfigHandler } from "./routes/orgfs-config";
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
  publish,
} from "./routes/git";
import {
  makeConfigReadHandler,
  makeConfigUpdateHandler,
} from "./routes/config";
import { handleCancelRequest, handleDispatchRequest } from "./routes/dispatch";
// Import harness factories from their subpaths (rather than the studio barrel).
// The daemon runs desktop CLI harnesses only; Decopilot remains cluster-side.
import { claudeCodeHarnessFactory } from "@decocms/harness/claude-code/index";
import { codexHarnessFactory } from "@decocms/harness/codex/index";
import {
  getHarnessFactory,
  registerHarnessFactory,
} from "@decocms/harness/registry";
import type {
  HarnessContext,
  HarnessId,
  HarnessStreamInput,
} from "@decocms/harness/types";
import { metrics, trace } from "@opentelemetry/api";
import { makeEventsHandler } from "./routes/events-stream";
import { makeExecHandler } from "./routes/exec";
import { makeToolsSyncHandler } from "./routes/tools";
import { makeCatalogSync } from "./tools-catalog";
import {
  makeReadHandler,
  makeWriteHandler,
  makeUnlinkHandler,
  makeMkdirHandler,
  makeRenameHandler,
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
  // Offload re-inflate config for `/dispatch`. These gate which hosts an
  // offloaded `messagesRef.url` may be fetched from (the SSRF allowlist) and
  // whether http:// loopback is permitted for local dev. They come from the
  // daemon's boot env, NEVER from the request frame.
  //
  // CONTRACT: studio must populate these when spawning the daemon —
  //   OFFLOAD_ALLOWED_HOSTS      comma-separated hostnames (object-store host(s))
  //   OFFLOAD_ALLOW_SAME_HOST_DEV "1" to allow http:// loopback (dev only)
  // The default is an EMPTY allowlist, which fails CLOSED: with no env wired,
  // every offload fetch is rejected (safe — no SSRF surface).
  offloadAllowedHosts: (process.env.OFFLOAD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0),
  offloadAllowSameHostDev: process.env.OFFLOAD_ALLOW_SAME_HOST_DEV === "1",
};
// Ensure repoDir exists so bash commands with the default cwd don't fail with
// ENOENT when no repo has been cloned yet (tool-only sandboxes, no-repo agents).
mkdirSync(bootConfig.repoDir, { recursive: true });
// Workspace layout: <appRoot>/repo (cloned source), <appRoot>/tmp/{app,taskN}
// (log tees). Everything inside appRoot is reachable by fs/bash routes
// (clamped to appRoot).
const TMP_DIR = join(APP_ROOT, "tmp");

const broadcaster = new Broadcaster(REPLAY_BYTES);

// `application.port` is what studio told the dev script to use, but plenty of
// frameworks (vite included) ignore PORT env and pick their own — and on the
// host runner two sandboxes can race for the same default port, leaving the
// loser on a fallback. Sniff the actual bind announcement from starter
// stdout and feed THAT to the probe; the configured port stays as a
// fallback for tools that do honor PORT.
const portSniffer = createPortSniffer();
// Assigned once the probe is started below; the moment the sniffer locks a
// port (dev server announced its bind URL = ready) we kick the probe so it
// confirms and flips to `running` immediately instead of on its next tick.
let kickProbe = (): void => {};
const broadcastChunkRaw = broadcaster.broadcastChunk.bind(broadcaster);
broadcaster.broadcastChunk = (source, data, opts) => {
  if (portSniffer.observe(source, data)) kickProbe();
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
const { state: lastProbe, checkNow: probeCheckNow } = startUpstreamProbe({
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
      // Dev server is confirmed healthy — safe to publish this boot's fresh
      // install as the golden node_modules (no-op unless one is pending). Only
      // publishing from a boot that actually came up keeps a broken install
      // from becoming a sticky, reused golden. Best-effort, fire-and-forget.
      if (wasDown) void orchestrator.publishPendingGolden();
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
kickProbe = probeCheckNow;

// HTTP/WS proxy forwards to the same port the probe is HEAD-checking.
// `application.port` is what studio configured, but vite/etc. routinely
// pick a fallback when the configured one is busy — using the sniffed
// announce-port keeps the proxy aligned with what the dev script
// actually bound to. Falls back to the configured value when nothing has
// been sniffed yet.
const getDevPort = (): number | null =>
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  portSniffer.current() ?? store.read()?.application?.port ?? null;
const { appRoot, repoDir } = bootConfig;
let fileChangedDebounce: ReturnType<typeof setTimeout> | null = null;
let pendingPaths = new Set<string>();

const FILE_CHANGED_DEBOUNCE_MS = 300;

function emitFileChanged(filePath: string) {
  pendingPaths.add(filePath);
  if (fileChangedDebounce) clearTimeout(fileChangedDebounce);
  fileChangedDebounce = setTimeout(() => {
    fileChangedDebounce = null;
    const paths = pendingPaths;
    pendingPaths = new Set();
    for (const p of paths) {
      broadcaster.emit("file-changed", { path: p });
    }
  }, FILE_CHANGED_DEBOUNCE_MS);
}

// Filesystem watcher callback — fires for any repo file change (editor, build
// tool, agent write, etc.) detected by BranchStatusMonitor's recursive
// fs.watch. Shares the same debounce as onWorkingTreeWrite so rapid edits
// (save + HMR rewrite) coalesce into one SSE burst.
branchStatus.onFileChanged = (filePath: string) => {
  emitFileChanged(filePath);
};

const fsDeps = {
  appRoot,
  repoDir,
  onWorkingTreeWrite: (filePath: string) => {
    if (process.env.DEBUG_SAVE_CHANGES === "1") {
      console.log("[branch-status] fs write/edit → refresh", { repoDir });
    }
    branchStatus.refresh();
    emitFileChanged(filePath);
  },
};
const readH = makeReadHandler(fsDeps);
const toolsSyncH = makeToolsSyncHandler(fsDeps);
// Coalesced, min-interval catalog sync for the fire-and-forget dispatch hook —
// re-syncing on every run would be wasted work + a write race.
const catalogSync = makeCatalogSync({ appRoot, repoDir });
const writeH = makeWriteHandler(fsDeps);
const unlinkH = makeUnlinkHandler(fsDeps);
const mkdirH = makeMkdirHandler(fsDeps);
const renameH = makeRenameHandler(fsDeps);
const editH = makeEditHandler(fsDeps);
const grepH = makeGrepHandler(fsDeps);
const globH = makeGlobHandler(fsDeps);
const writeFromUrlH = makeWriteFromUrlHandler(fsDeps);
const uploadToUrlH = makeUploadToUrlHandler(fsDeps);

const bashH = makeBashHandler({
  repoDir,
  taskManager,
});
const gitDeps = {
  appRoot,
  repoDir,
  getCloneUrl: () => store.read()?.git?.repository?.cloneUrl ?? null,
  getOperator: () => store.read()?.operator ?? null,
};
const gitStatusH = makeGitStatusHandler(gitDeps);
const gitDiffH = makeGitDiffHandler(gitDeps);
const gitPublishH = makeGitPublishHandler(gitDeps);
const gitDiscardH = makeGitDiscardHandler(gitDeps);
const gitRebaseH = makeGitRebaseHandler(gitDeps);
const execH = makeExecHandler({
  repoDir,
  store,
  taskManager,
  lifecycle,
  getStatus: () => currentStatus,
  setStatus,
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

// ─── Harness dispatch ──────────────────────────────────────────────────
// Authenticated by the bearer `bootConfig.daemonToken` (see `./auth`). The
// link daemon's `handleLocalDispatch` posts a HarnessStreamInput here over
// loopback when it pulls a work item; the daemon spawns the named factory's
// CLI in-process and streams `UIMessageChunk` back as SSE.
//
// The CLI factories live in the daemon. The cluster `decopilotHarnessFactory`
// (RunRegistry, run-stream internals, StudioContext) is NOT here.
// Register the daemon's harness factories into the shared @decocms/harness
// registry (the same registry the cluster barrel uses, but a separate
// module-singleton in the daemon process). Keys are the factory ids
// (claude-code / codex). Lookup goes through `getHarnessFactory` so the daemon
// and the cluster share one registry abstraction.
registerHarnessFactory(claudeCodeHarnessFactory);
registerHarnessFactory(codexHarnessFactory);
const dispatchTracer = trace.getTracer("link-daemon");
const dispatchMeter = metrics.getMeter("link-daemon");
const lookupDispatchHarness = (id: string, input: unknown) => {
  const factory = getHarnessFactory(id as HarnessId);
  if (!factory) throw new Error(`unknown harness: ${id}`);
  // Build a minimal HarnessContext. CLI harnesses don't read storage,
  // db, vault, or aiProviders — they only need tracer/meter for OTel
  // and metadata for span attributes. The cluster's richer StudioContext
  // is structurally compatible with this shape (see
  // `apps/api/src/core/harness-context.ts`).
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
  return {
    // Share-files-back: point `org/output` at this run's thread subtree of the
    // outputs volume before the harness can touch it. Awaited so the link is
    // correct from the run's first write; failures degrade to no link (never
    // block the run).
    stream: async function* () {
      await repointOutputLinkForRun(harnessInput.threadId);
      yield* harness.stream(harnessInput);
    },
  };
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
  repoDir: bootConfig.repoDir,
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

async function hydrate(): Promise<void> {
  const diskOutcome = await readConfig(bootConfig.repoDir);
  if (diskOutcome.kind === "invalid") {
    console.warn(
      `[daemon] ignoring .decocms/daemon.json: ${diskOutcome.reason}`,
    );
  }
  if (diskOutcome.kind !== "valid") return;
  const initial: TenantConfig = diskOutcome.config;
  store.hydrate(initial);
  orchestrator.handle({ kind: "bootstrap", config: initial });
}

await hydrate();

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
  "/mkdir": mkdirH,
  "/rename": renameH,
  "/edit": editH,
  "/grep": grepH,
  "/glob": globH,
  "/write_from_url": writeFromUrlH,
  "/upload_to_url": uploadToUrlH,
  "/bash": bashH,
  "/tools/sync": toolsSyncH,
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
  if (method === "GET" && vmPath === "/events") return eventsH(req);
  if (method === "GET" && vmPath === "/scripts") return scriptsHandler();
  if (method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS_HEADERS });

  // Harness dispatch + cancel read their own body, so keep them inline
  // (they run the bearer-token check themselves before parsing).
  if (method === "POST" && vmPath === "/dispatch") {
    return handleDispatchRequest(req, {
      daemonToken: bootConfig.daemonToken,
      lookupHarness: lookupDispatchHarness,
      allowedHosts: bootConfig.offloadAllowedHosts,
      allowSameHostDev: bootConfig.offloadAllowSameHostDev,
      onDispatchMcp: catalogSync,
    });
  }
  if (method === "DELETE" && vmPath.startsWith("/runs/")) {
    return handleCancelRequest(req, {
      daemonToken: bootConfig.daemonToken,
    });
  }

  const denied = requireToken(req, bootConfig.daemonToken);
  if (denied) return denied;

  // Hosted harnesses drive the sandbox through the fs/exec tool routes
  // WITHOUT a /dispatch envelope, so the org links must be ensured here too —
  // before bash/read/write resolve the prompts' relative `org/...` paths.
  // vm-tools stamp the thread on each call (x-thread-id) so `org/output` can
  // point at the running thread's folder; memoized, so repeat calls cost one
  // lstat. ONLY those routes: gating /orgfs-config would deadlock cluster
  // provisioning into the full fail-open wait (the mounts the gate polls for
  // appear only after that POST lands), and gating /setup/clone would create
  // `repo/org` ahead of the clone — the boot-time hazard repo-link.ts exists
  // to avoid. The other routes (config/tasks/git) never resolve org paths.
  if (method === "POST" && (vmPath in fsH || vmPath.startsWith("/exec/"))) {
    const vmThreadId = req.headers.get("x-thread-id");
    if (vmThreadId) {
      await repointOutputLinkForRun(vmThreadId);
    } else {
      await ensureOrgRepoLink();
    }
  }

  // Buffer body once and re-inject as a fresh Request for downstream
  // handlers that re-read it.
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";
  const body = hasBody ? await req.text() : "";

  const rebuilt = hasBody
    ? new Request(req.url, { method, headers: req.headers, body })
    : req;

  if (vmPath === "/config") return configH(rebuilt, prefix);
  if (method === "POST" && vmPath === "/orgfs-config")
    return orgFsConfigH(rebuilt);
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

// --- Org-filesystem mounts ---------------------------------------------------
// Desktop links: the studio sets ORGFS_CONFIG (a JSON OrgFsMountConfig) +
// ORGFS_RCLONE_PATH at spawn — as boot env, like OFFLOAD_ALLOWED_HOSTS, so the
// daemon itself mounts here at boot.
// Cluster pods: this container can't mount (locked-down securityContext); a
// privileged sidecar does (org-fs/sidecar.ts). The studio runner POSTs the
// config to /_sandbox/orgfs-config post-bind (warm-pool claims reject
// spec.env) and the handler relays it onto the shared control volume the
// sidecar watches. Both paths are inert unless their env is set; every step
// is guarded — a mount failure never affects the daemon or harnesses.
let mountManager: MountManager | null = null;
{
  const orgFs = parseOrgFsConfig(process.env.ORGFS_CONFIG);
  const rclonePath = process.env.ORGFS_RCLONE_PATH;
  if (orgFs && rclonePath) {
    mountManager = new MountManager(createRcloneMounter(rclonePath));
    void mountManager
      .start(orgFs, bootConfig.appRoot)
      .catch((err) => console.warn("[org-fs] mount start failed", err));
  }
}
const orgFsConfigH = makeOrgFsConfigHandler({
  configPath: process.env.ORGFS_SIDECAR_CONFIG_PATH,
});

/**
 * Per-run thread links (`org/output` → `.outputs/<threadId>` and
 * `org/upload` → `.uploads/<threadId>`, see org-fs/thread-links.ts). Gated on
 * the volumes being ACTUALLY mounted — a mount-point dir exists locally even
 * when the mount failed, and linking into that would silently strand files on
 * local disk. The mount is either ours (desktop) or the sidecar's (cluster —
 * its status file reports what it mounted). Hoisted declaration: called from
 * `lookupDispatchHarness` above, which only runs post-boot.
 */
const orgFsLog = (msg: string, err?: unknown) =>
  err ? console.warn(`[org-fs] ${msg}`, err) : console.log(`[org-fs] ${msg}`);

/** Org-fs is expected on this daemon (desktop boot env or cluster sidecar). */
const orgFsExpected =
  Boolean(process.env.ORGFS_CONFIG) ||
  Boolean(process.env.ORGFS_SIDECAR_CONFIG_PATH);

/** Active org-fs mounts: ours (desktop) or the sidecar's (cluster). */
async function activeOrgFsMounts(): Promise<{ mountPath: string }[]> {
  const own = mountManager?.list() ?? [];
  if (own.length > 0) return own;
  const statusPath = process.env.ORGFS_SIDECAR_STATUS_PATH;
  if (!statusPath) return [];
  const status = await readFile(statusPath, "utf8")
    .then((raw) => JSON.parse(raw) as SidecarStatus)
    .catch(() => null);
  return status?.mounts ?? [];
}

const FIRST_MOUNT_WAIT_MS = 10_000;
const FIRST_MOUNT_POLL_MS = 250;
let firstMountWait: Promise<boolean> | null = null;

/**
 * First-touch grace: a freshly provisioned sandbox can receive its first tool
 * call while the sidecar is still attaching the mounts (~2-5s after the config
 * relay), making the agent's very first `ls org/` race the mount. Wait once —
 * shared across concurrent requests, deadline-bounded, fail-open (timeout →
 * proceed without the link; the lazy hook self-heals on a later call). After
 * this single window every request takes the cheap path, so a broken sidecar
 * can never introduce a recurring stall.
 */
function waitForFirstMounts(): Promise<boolean> {
  firstMountWait ??= (async () => {
    const deadline = Date.now() + FIRST_MOUNT_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await activeOrgFsMounts()).length > 0) return true;
      await sleep(FIRST_MOUNT_POLL_MS);
    }
    orgFsLog(
      `mounts not up after ${FIRST_MOUNT_WAIT_MS}ms; continuing without`,
    );
    return false;
  })();
  return firstMountWait;
}

/**
 * Make the prompts' relative `org/...` paths resolve from the harness cwd
 * (`<appRoot>/repo`) — see org-fs/repo-link.ts. Lazy + idempotent: called on
 * every vm tool request, no-op while nothing is mounted, one lstat after.
 */
async function ensureOrgRepoLink(): Promise<void> {
  if (!orgFsExpected) return;
  if ((await activeOrgFsMounts()).length === 0) {
    if (!(await waitForFirstMounts())) return;
    if ((await activeOrgFsMounts()).length === 0) return;
  }
  await ensureRepoOrgLink(bootConfig.repoDir, orgFsLog);
}

// Last thread `org/output` points at. Owned by repointOutputLinkForRun so
// EVERY caller (the /dispatch path and the vm-route x-thread-id header)
// keeps it consistent with the actual symlink — a cache updated by only one
// surface would let the other silently misroute writes across threads.
let lastOutputThread: string | null = null;

async function repointOutputLinkForRun(threadId: string): Promise<boolean> {
  if (!orgFsExpected) return false;
  if (threadId === lastOutputThread) {
    // Link already points here; keep the repo link fresh (one lstat).
    await ensureRepoOrgLink(bootConfig.repoDir, orgFsLog);
    return true;
  }
  let mounts = await activeOrgFsMounts();
  if (mounts.length === 0) {
    if (!(await waitForFirstMounts())) return false;
    mounts = await activeOrgFsMounts();
    if (mounts.length === 0) return false;
  }
  await ensureRepoOrgLink(bootConfig.repoDir, orgFsLog);
  // Uploads link is best-effort: sandboxes provisioned before the uploads
  // volume existed have no .uploads mount, and inbound attachments flow
  // through the studio regardless — never fail the run over it.
  const uploadsMountPath = join(bootConfig.appRoot, "org", ".uploads");
  if (mounts.some((m) => m.mountPath === uploadsMountPath)) {
    await repointUploadLink(bootConfig.appRoot, threadId, orgFsLog);
  }
  const outputsMountPath = join(bootConfig.appRoot, "org", ".outputs");
  if (!mounts.some((m) => m.mountPath === outputsMountPath)) return false;
  // Cache only a CONFIRMED repoint — repointOutputLink fails soft (logs and
  // returns false), and caching a failure would pin the memo at this thread
  // while the symlink still points at the PREVIOUS one, with no retry.
  if (!(await repointOutputLink(bootConfig.appRoot, threadId, orgFsLog))) {
    return false;
  }
  lastOutputThread = threadId;
  return true;
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  taskManager.shutdown();
  branchStatus.stop();
  // Publish BEFORE unmount: syncing the user's work is the only irrecoverable
  // step. A stale mount is backstopped (sync `exit` handler + next-boot
  // reclaim), so a hanging unmount must never eat the push's slice of the grace
  // period. Reuse the same publish() path as POST /_sandbox/git/publish so the
  // shutdown sync inherits credentialed-remote setup, hook-skipping, and
  // non-interactive push — the blind add/commit/push it replaced silently
  // failed on GitHub repos whose origin URL lacked embedded credentials and
  // could hang on a credential prompt until SIGKILL.
  const branch = store.read()?.git?.repository?.branch;
  if (branch) {
    try {
      // "skip" (not "throw"): an invalid decofile block must not abort the whole
      // shutdown sync — that would silently lose the user's other valid work when
      // the sandbox is torn down. Sync everything else; the bad block stays
      // uncommitted and is discarded on the next re-clone.
      await publish(
        gitDeps,
        "chore(daemon): sync all local changes to remote on shutdown",
        { onInvalidBlock: "skip" },
      );
    } catch (err) {
      console.warn("[daemon] shutdown publish failed", err);
    }
  }
  // rclone --daemon detaches, so an unmount here stops it from outliving us.
  // Best-effort: a truly abrupt SIGKILL skips it and the backstops above cover.
  if (mountManager) {
    await mountManager.stop().catch(() => {});
  }
  process.exit(0);
}

// SIGINT too: the user Ctrl-C'ing the `decocms link` terminal signals the whole
// process group, and without a handler the default action skips the unmount —
// leaving a stale macOS NFS mount that hangs and pops the reconnect dialog.
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

// Last-resort synchronous detach for any path that bypassed shutdown() (a raw
// process.exit, or shutdown() not finishing). After stop() ran, list() is empty
// so this is a no-op; it only does work on the residual exit path. `umount -f`
// is the non-blocking force-detach — detaching the kernel mount is what stops
// the hang/dialog; the orphaned rclone child then exits on its own.
const isMac = process.platform === "darwin";
process.on("exit", () => {
  for (const { mountPath } of mountManager?.list() ?? []) {
    try {
      detachMount(mountPath, isMac);
    } catch {
      // best-effort
    }
  }
});

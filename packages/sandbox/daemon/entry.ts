import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bumpActivity, markClaimed } from "./activity";
import { requireToken } from "./auth";
import { TenantConfigStore } from "./config-store";
import { REPLAY_BYTES } from "./constants";
import { Broadcaster } from "./events/broadcast";
import { BranchStatusMonitor } from "./git/branch-status";
import { gitSync } from "./git/git-sync";
import { InstallState } from "./install/install-state";
import { readConfig } from "./persistence";
import { TaskManager } from "./process/task-manager";
import { PhaseManager } from "./process/phase-manager";
import { startUpstreamProbe } from "./probe";
import { makeProxyHandler } from "./proxy";
import { jsonResponse } from "./routes/body-parser";
import { makeBashHandler } from "./routes/bash";
import {
  makeConfigReadHandler,
  makeConfigUpdateHandler,
} from "./routes/config";
import { makeEventsHandler } from "./routes/events-stream";
import { makeExecHandler } from "./routes/exec";
import {
  makeReadHandler,
  makeWriteHandler,
  makeEditHandler,
  makeGrepHandler,
  makeGlobHandler,
  makeWriteFromUrlHandler,
  makeUploadToUrlHandler,
} from "./routes/fs";
import { makeHealthHandler } from "./routes/health";
import { makeIdleHandler } from "./routes/idle";
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

type Intent = { state: "running" | "paused"; reason?: string };
let currentIntent: Intent = { state: "running" };
function setIntent(next: Intent) {
  currentIntent = next;
  broadcaster.broadcastEvent("intent", { type: "intent", ...next });
}

const store = new TenantConfigStore();
const installState = new InstallState();
const phaseManager = new PhaseManager({
  onChange: (phases) =>
    broadcaster.broadcastEvent("phases", { type: "phases", phases }),
});
const taskManager = new TaskManager({
  logsDir: TMP_DIR,
  phaseManager,
  broadcaster,
  onChange: () => {
    broadcaster.broadcastEvent("tasks", {
      type: "tasks",
      active: getActiveTasks(),
    });
  },
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
  setIntent,
  getIntent: () => currentIntent,
  broadcaster,
  installState,
  logsDir: TMP_DIR,
  phaseManager,
  branchStatus,
});

let discoveredScripts: string[] | null = null;

const origEvent = broadcaster.broadcastEvent.bind(broadcaster);
broadcaster.broadcastEvent = (event: string, data: unknown) => {
  if (event === "scripts") {
    discoveredScripts = (data as { scripts?: string[] }).scripts ?? [];
  }
  origEvent(event, data);
};

store.subscribe((event) => {
  orchestrator.handle(event.transition);
});

const lastStatus = startUpstreamProbe({
  getPort: () => store.read()?.application?.port ?? null,
  onChange: (s) => {
    broadcaster.broadcastEvent("status", { type: "status", ...s });
  },
  onLog: (msg) => broadcaster.broadcastChunk("setup", msg),
});

const getDevPort = (): number | null => store.read()?.application?.port ?? null;
const { appRoot, repoDir } = bootConfig;
const fsDeps = { appRoot, repoDir };
const readH = makeReadHandler(fsDeps);
const writeH = makeWriteHandler(fsDeps);
const editH = makeEditHandler(fsDeps);
const grepH = makeGrepHandler(fsDeps);
const globH = makeGlobHandler(fsDeps);
const writeFromUrlH = makeWriteFromUrlHandler(fsDeps);
const uploadToUrlH = makeUploadToUrlHandler(fsDeps);

const bashH = makeBashHandler({
  repoDir,
  taskManager,
});
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
  if (discoveredScripts) return discoveredScripts;
  const enriched = store.read();
  const pm = enriched?.application?.packageManager?.name ?? null;
  const cwd = enriched?.application?.packageManager?.path ?? repoDir;
  if (!pm) return [];
  return discoverScripts(cwd, pm);
});

const healthH = makeHealthHandler({
  config: { daemonBootId: process.env.DAEMON_BOOT_ID ?? "" },
  getReady: () => lastStatus.status === "online",
  getOrchestrator: () => ({
    running: orchestrator.isRunning(),
    pending: orchestrator.pendingCount(),
  }),
  getConfigured: () => store.read() !== null,
});

const eventsH = makeEventsHandler({
  broadcaster,
  getLastStatus: () => lastStatus,
  getDiscoveredScripts: () => discoveredScripts,
  getActiveTasks,
  getIntent: () => currentIntent,
  getLastBranchStatus: () => branchStatus.getLast(),
});

const idleH = makeIdleHandler();
const proxyH = makeProxyHandler({ broadcaster, getDevPort });
const wsProxy = makeWsUpgrader(getDevPort, { onClientMessage: bumpActivity });

const configReadH = makeConfigReadHandler({
  daemonBootId: process.env.DAEMON_BOOT_ID ?? "",
  store,
  getState: () => ({
    orchestrator: {
      running: orchestrator.isRunning(),
      pending: orchestrator.pendingCount(),
    },
    ready: lastStatus.status === "online",
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

let firstWorkLogged = false;

async function configH(req: Request): Promise<Response> {
  const { method } = req;
  if (method === "GET") return configReadH();
  if (method === "PUT" || method === "POST") {
    const res = await configUpdateH(req);
    // Mark daemon as claimed on first successful config delivery so the
    // housekeeper can distinguish warm-pool pods awaiting adoption from
    // idle-but-active sandboxes.
    if (res.status === 200) markClaimed();
    return res;
  }
  return jsonResponse({ error: "Not found: /_decopilot_vm/config" }, 404);
}

function tasksRouteH(
  req: Request,
  method: string,
  vmPath: string,
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
  return jsonResponse({ error: `Not found: /_decopilot_vm${vmPath}` }, 404);
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
  "/edit": editH,
  "/grep": grepH,
  "/glob": globH,
  "/write_from_url": writeFromUrlH,
  "/upload_to_url": uploadToUrlH,
  "/bash": bashH,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Cache-Control, Authorization",
};

function vmRouteH(
  req: Request,
  method: string,
  vmPath: string,
): Response | Promise<Response> {
  if (method === "GET" && vmPath === "/idle") return idleH();
  if (method === "GET" && vmPath === "/events") return eventsH();
  if (method === "GET" && vmPath === "/scripts") return scriptsHandler();
  if (method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS_HEADERS });

  const denied = requireToken(req, bootConfig.daemonToken);
  if (denied) return denied;

  if (vmPath === "/config") return configH(req);
  if (vmPath.startsWith("/tasks")) return tasksRouteH(req, method, vmPath);
  if (method === "POST" && vmPath in fsH) return fsH[vmPath](req);
  if (method === "POST" && vmPath.startsWith("/exec/"))
    return execRouteH(req, vmPath);

  return jsonResponse({ error: `Not found: /_decopilot_vm${vmPath}` }, 404);
}

Bun.serve<WsProxyData, never>({
  port: bootConfig.proxyPort,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req, server) {
    const { pathname: p } = new URL(req.url);
    const { method } = req;

    if (p !== "/health" && p !== "/_decopilot_vm/idle") {
      bumpActivity();
      if (!firstWorkLogged) {
        firstWorkLogged = true;
        console.log(
          `[daemon] boot_id=${process.env.DAEMON_BOOT_ID} first request: METHOD=${method} PATH=${p}`,
        );
      }
    }

    if (
      req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
      !p.startsWith("/_decopilot_vm/")
    ) {
      const ok = server.upgrade(req, { data: wsProxy.upgradeData(req) });
      return ok
        ? (undefined as unknown as Response)
        : new Response("Upgrade failed", { status: 400 });
    }

    if (method === "GET" && p === "/health") return healthH();
    if (p.startsWith("/_decopilot_vm/"))
      return vmRouteH(req, method, p.slice("/_decopilot_vm".length));
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

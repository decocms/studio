/**
 * Freestyle sandbox runner — hosted.
 *
 * One VM per (user, projectRef). Freestyle owns the runtime; mesh calls
 * `freestyle.vms.{create, ref({vmId, spec}).start, stop, delete}`. The VM
 * bakes in the bundled daemon binary (daemon/dist/daemon.js) via
 * additionalFiles, with per-VM config injected through systemd env vars on
 * the daemon service — so there's no in-package bootstrap path and no
 * port-forward — the preview URL is a Freestyle-provided HTTPS domain.
 *
 * Daemon traffic at `/_decopilot_vm/*` is base64-encoded body-wise to dodge
 * Freestyle's Cloudflare WAF.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { VmBun } from "@freestyle-sh/with-bun";
import { VmDeno } from "@freestyle-sh/with-deno";
import { VmNodeJs } from "@freestyle-sh/with-nodejs";
import { freestyle, VmSpec } from "freestyle-sandboxes";
import {
  computeHandle,
  deriveRepoLabel,
  Inflight,
  withSandboxLock,
} from "../shared";
import type { RunnerStateStore, RunnerStateStoreOps } from "../state-store";
import {
  sandboxIdKey,
  type EnsureOptions,
  type ExecInput,
  type ExecOutput,
  type ProxyRequestInit,
  type Sandbox,
  type SandboxId,
  type SandboxRunner,
  type Workload,
} from "../types";
import type { ClaimPhase } from "../lifecycle-types";
// Inlined as a string at build time. Path lookup via import.meta.url breaks
// once the server is bundled into apps/mesh/dist/server/server.js because
// `../../../` then resolves outside the published package. The text-import
// attribute makes bun build embed the daemon bytes directly into server.js,
// so no asset has to ship alongside the bundle.
// @ts-expect-error - Bun-specific text loader attribute; TS resolves the
// underlying .js file and doesn't model `with { type: "text" }`.
import _daemonBundle from "../../../daemon/dist/daemon.js" with {
  type: "text",
};
const DAEMON_BUNDLE_CONTENT: string = _daemonBundle;

const RUNNER_KIND = "freestyle" as const;
const LOG_LABEL = "FreestyleSandboxRunner";
const PROXY_PORT = 9000;
const APP_WORKDIR = "/app";
const DAEMON_TOKEN_BYTES = 32;
const ALIVE_PROBE_TIMEOUT_MS = 2_000;
const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const DISPOSE_TIMEOUT_MS = 10_000;
/** Stop running VMs after this much idle time. Freestyle bills per active second. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

type PhaseLog = (msg: string, fields?: Record<string, unknown>) => void;

function makePhaseLog(scope: string): PhaseLog {
  const t0 = Date.now();
  return (msg, fields = {}) => {
    const tail = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    console.log(
      `[${scope}] +${Date.now() - t0}ms ${msg}${tail ? ` ${tail}` : ""}`,
    );
  };
}

/**
 * Pull as much detail as possible from an unknown thrown value. SDK errors
 * may wrap an HTTP Response, attach a `cause`, or be plain objects — bare
 * `err.message` regularly produces "[object Object]" in the logs.
 */
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (err.stack) out.stack = err.stack.split("\n").slice(0, 4).join(" | ");
    if ("cause" in err && err.cause !== undefined) {
      out.cause =
        err.cause instanceof Error
          ? `${err.cause.name}: ${err.cause.message}`
          : String(err.cause);
    }
    if ("status" in err && typeof err.status === "number")
      out.status = err.status;
    if ("code" in err) out.code = String(err.code);
    if ("response" in err && err.response && typeof err.response === "object") {
      const resp = err.response as { status?: number; statusText?: string };
      out.responseStatus = resp.status;
      out.responseStatusText = resp.statusText;
    }
    return out;
  }
  if (err === null || err === undefined) return { err: String(err) };
  if (typeof err === "object") {
    try {
      return { raw: JSON.stringify(err) };
    } catch {
      return { raw: Object.prototype.toString.call(err) };
    }
  }
  return { raw: String(err) };
}

export interface FreestyleRunnerOptions {
  stateStore?: RunnerStateStore;
  /** Override when the freestyle account uses a custom apex. Default: `deco.studio`. */
  previewRootDomain?: string;
  /** Override for tests / staging where you want longer-lived VMs. */
  idleTimeoutSeconds?: number;
}

interface FreestyleRecord {
  id: SandboxId;
  handle: string;
  vmId: string;
  previewDomain: string;
  workdir: string;
  workload: Workload | null;
  /** Persisted so VmSpec can be rebuilt deterministically on resume. */
  repo: NonNullable<EnsureOptions["repo"]>;
  /** Bearer token the in-VM daemon checks on every `/_decopilot_vm/*` request. */
  daemonToken: string;
  /** Per-sandbox UUID used by /health for restart detection. */
  daemonBootId: string;
}

interface PersistedFreestyleState {
  vmId: string;
  previewDomain: string;
  workdir: string;
  workload: Workload | null;
  repo: NonNullable<EnsureOptions["repo"]>;
  /** Added alongside bearer auth. Absent in pre-auth rows → resume bails. */
  daemonToken?: string;
  /** Added with bundle refactor. Absent in pre-refactor rows → generate fresh on resume. */
  daemonBootId?: string;
  [k: string]: unknown;
}

export class FreestyleSandboxRunner implements SandboxRunner {
  readonly kind = RUNNER_KIND;

  private readonly records = new Map<string, FreestyleRecord>();
  private readonly inflight = new Inflight<string, Sandbox>();
  private readonly stateStore: RunnerStateStore | null;
  private readonly previewRootDomain: string;
  private readonly idleTimeoutSeconds: number;

  constructor(opts: FreestyleRunnerOptions = {}) {
    this.stateStore = opts.stateStore ?? null;
    this.previewRootDomain = opts.previewRootDomain ?? "deco.studio";
    this.idleTimeoutSeconds =
      opts.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  }

  // ---- SandboxRunner surface ------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    if (!opts.repo) {
      throw new Error(
        `[${LOG_LABEL}] requires opts.repo — bake-in clone is part of the VmSpec; blank sandboxes aren't supported.`,
      );
    }
    if (!opts.repo.branch) {
      throw new Error(
        `[${LOG_LABEL}] requires opts.repo.branch — the daemon clones with -b and the branch is part of the spec.`,
      );
    }
    const key = sandboxIdKey(id);
    return this.inflight.run(key, () =>
      withSandboxLock(this.stateStore, id, RUNNER_KIND, (ops) =>
        this.ensureLocked(id, opts, ops),
      ),
    );
  }

  /** Routes through the daemon transport so CORS/bearer match file-ops. */
  async exec(handle: string, input: ExecInput): Promise<ExecOutput> {
    const rec = await this.requireRecord(handle);
    const res = await this.postDaemon(rec, "/_decopilot_vm/bash", {
      command: input.command,
      timeout: input.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS,
      cwd: input.cwd,
      env: input.env,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `freestyle daemon /_decopilot_vm/bash returned ${res.status}${body ? `: ${body}` : ""}`,
      );
    }
    const json = (await res.json()) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };
    return {
      stdout: json.stdout ?? "",
      stderr: json.stderr ?? "",
      exitCode: json.exitCode ?? -1,
      // Daemon has no timed-out flag; exitCode === -1 is set by kill-on-timeout.
      timedOut: (json.exitCode ?? 0) === -1,
    };
  }

  async delete(handle: string): Promise<void> {
    const rec = await this.getRecord(handle);
    this.records.delete(handle);
    if (rec) {
      await disposeVm(rec.vmId, "delete");
      if (this.stateStore) await this.stateStore.delete(rec.id, RUNNER_KIND);
    } else if (this.stateStore) {
      await this.stateStore.deleteByHandle(RUNNER_KIND, handle);
    }
  }

  /** Freestyle SDK has no cheap status check; small GET is our best signal. */
  async alive(handle: string): Promise<boolean> {
    const rec = await this.getRecord(handle);
    if (!rec) return false;
    try {
      const res = await fetch(
        `https://${rec.previewDomain}/_decopilot_vm/scripts`,
        {
          headers: { authorization: `Bearer ${rec.daemonToken}` },
          signal: AbortSignal.timeout(ALIVE_PROBE_TIMEOUT_MS),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    const rec = await this.getRecord(handle);
    return rec ? `https://${rec.previewDomain}` : null;
  }

  // Freestyle's setup is end-to-end inside `runner.ensure` (clone, install,
  // dev start all happen before the SDK call returns). No pre-Ready window
  // mesh could surface; yield a single `ready` and let the caller proceed
  // straight to the daemon SSE.
  async *watchClaimLifecycle(
    _handle: string,
    _signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    yield { kind: "ready" };
  }

  /**
   * Translates Docker's canonical `/_daemon/*` to freestyle's `/_decopilot_vm/*`:
   *   /_daemon/fs/<op>         → /_decopilot_vm/<op>
   *   /_daemon/bash            → /_decopilot_vm/bash
   *   /_daemon/_decopilot_vm/… → /_decopilot_vm/… (browser SSE)
   *   /_daemon/dev/…           → 204 (systemd handles dev on freestyle)
   * Bodies are base64-encoded to dodge the Cloudflare WAF.
   */
  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    const rec = await this.getRecord(handle);
    if (!rec) {
      return new Response(JSON.stringify({ error: "sandbox not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const target = `https://${rec.previewDomain}${path}`;
    const headers = new Headers(init.headers);
    // Strip cookies + hop-by-hop, then set our own bearer.
    for (const h of [
      "cookie",
      "host",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "accept-encoding",
      "content-length",
      "authorization",
    ]) {
      headers.delete(h);
    }
    headers.set("authorization", `Bearer ${rec.daemonToken}`);
    const hasBody = init.method !== "GET" && init.method !== "HEAD";
    let body: BodyInit | null = init.body;
    if (hasBody && body !== null) {
      // Freestyle daemon's parseJsonBody expects base64 → percent-encoded UTF-8 → JSON.
      const text =
        typeof body === "string"
          ? body
          : body instanceof Uint8Array
            ? new TextDecoder().decode(body)
            : await new Response(body).text();
      body = encodeBase64Utf8(text);
      headers.set("content-type", "text/plain");
    }
    return fetch(target, {
      method: init.method,
      headers,
      body: hasBody ? body : undefined,
      redirect: "manual",
      signal: init.signal,
      // @ts-expect-error Bun/Undici-only: allow streaming request body.
      duplex: hasBody ? "half" : undefined,
    });
  }

  // ---- Ensure flow ----------------------------------------------------------

  private async ensureLocked(
    id: SandboxId,
    opts: EnsureOptions,
    ops: RunnerStateStoreOps | null,
  ): Promise<Sandbox> {
    const log = makePhaseLog(LOG_LABEL);
    log("ensure start", { userId: id.userId, projectRef: id.projectRef });
    // 1. State-store resume.
    if (ops) {
      const persisted = await ops.get(id, RUNNER_KIND);
      log("state-store get done", { persisted: !!persisted });
      if (persisted) {
        const rec = await this.resume(id, persisted, opts, log);
        if (rec) {
          log("ensure ok via=resume", { handle: rec.handle });
          this.records.set(rec.handle, rec);
          return this.toSandbox(rec);
        }
        await ops.delete(id, RUNNER_KIND);
        log("resume rejected, falling through to provision");
      }
    }
    // 2. Fresh provision. No adopt path: freestyle has no tag-side lookup.
    log("provision start");
    const rec = await this.provision(id, opts, log);
    this.records.set(rec.handle, rec);
    await this.persist(ops, rec);
    log("ensure ok via=provision", { handle: rec.handle });
    return this.toSandbox(rec);
  }

  private async provision(
    id: SandboxId,
    opts: EnsureOptions,
    log: PhaseLog,
  ): Promise<FreestyleRecord> {
    const repo = opts.repo!;
    const workload = opts.workload ?? null;
    const previewDomain = `${this.computeDomainKey(id, repo.branch)}.${this.previewRootDomain}`;
    const daemonToken = randomBytes(DAEMON_TOKEN_BYTES).toString("hex");
    const daemonBootId = randomUUID();
    const spec = this.buildSpec({ repo, workload, daemonToken, daemonBootId });
    log("spec built", {
      previewDomain,
      runtime: workload?.runtime ?? "node",
      packageManager: workload?.packageManager ?? "(none)",
      branch: repo.branch ?? "(none)",
    });
    let result: { vmId: string };
    log("freestyle.vms.create start");
    try {
      result = await freestyle.vms.create({
        spec,
        domains: [{ domain: previewDomain, vmPort: PROXY_PORT }],
        recreate: true,
        idleTimeoutSeconds: this.idleTimeoutSeconds,
      });
    } catch (err) {
      log("freestyle.vms.create failed", describeError(err));
      throw new Error(
        `[${LOG_LABEL}] vms.create failed for domain=${previewDomain} user=${id.userId} projectRef=${id.projectRef}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    log("freestyle.vms.create ok", { vmId: result.vmId });
    return {
      id,
      handle: result.vmId,
      vmId: result.vmId,
      previewDomain,
      workdir: APP_WORKDIR,
      workload,
      repo,
      daemonToken,
      daemonBootId,
    };
  }

  /**
   * Resume a persisted record: validate the blob, bail on spec divergence,
   * then boot the VM via `freestyle.vms.ref({vmId, spec}).start()`. Returns
   * null to trigger purge-and-reprovision in the caller.
   */
  private async resume(
    id: SandboxId,
    persisted: { handle: string; state: Record<string, unknown> },
    opts: EnsureOptions,
    log: PhaseLog,
  ): Promise<FreestyleRecord | null> {
    const state = persisted.state as Partial<PersistedFreestyleState>;
    if (!state.vmId || !state.previewDomain || !state.repo) {
      log("resume bail: incomplete state");
      return null;
    }
    // Rows persisted before bearer auth landed have no daemonToken. The
    // running VM's daemon script also predates auth, so a new token wouldn't
    // match. Dispose the old VM explicitly — idle-timeout would orphan one
    // VM per stale row, which stacks up and is billed.
    if (!state.daemonToken) {
      log("resume bail: no daemonToken; disposing legacy vm", {
        vmId: state.vmId,
      });
      await disposeVm(state.vmId, "resume:no-daemon-token");
      return null;
    }
    // Workload (runtime / packageManager / devPort) is baked into the daemon
    // script at VM create time — see buildSpec.additionalFiles. When the
    // caller's workload has diverged, resume would silently keep running the
    // old PM. Bail so ensure deletes the stale state row and provisions fresh.
    if (!workloadEquals(opts.workload ?? null, state.workload ?? null)) {
      console.warn(
        `[${LOG_LABEL}] resume vm ${state.vmId} skipped: workload changed (persisted=${JSON.stringify(state.workload)} current=${JSON.stringify(opts.workload ?? null)}); will recreate`,
      );
      return null;
    }
    const workload = opts.workload ?? state.workload ?? null;
    const daemonBootId = state.daemonBootId ?? randomUUID();
    const spec = this.buildSpec({
      repo: state.repo,
      workload,
      daemonToken: state.daemonToken,
      daemonBootId,
    });
    log("resume vm.start network call", { vmId: state.vmId });
    try {
      const vm = freestyle.vms.ref({ vmId: state.vmId, spec });
      await vm.start();
    } catch (err) {
      log("resume vm.start failed", {
        vmId: state.vmId,
        ...describeError(err),
      });
      return null;
    }
    log("resume vm.start ok", { vmId: state.vmId });
    return {
      id,
      handle: state.vmId,
      vmId: state.vmId,
      previewDomain: state.previewDomain,
      workdir: state.workdir ?? APP_WORKDIR,
      workload,
      repo: state.repo,
      daemonToken: state.daemonToken,
      daemonBootId,
    };
  }

  // ---- Handle resolution (post-restart) -------------------------------------

  private async getRecord(handle: string): Promise<FreestyleRecord | null> {
    const cached = this.records.get(handle);
    if (cached) return cached;
    if (!this.stateStore) return null;
    const persisted = await this.stateStore.getByHandle(RUNNER_KIND, handle);
    if (!persisted) return null;
    const state = persisted.state as Partial<PersistedFreestyleState>;
    if (!state.vmId || !state.previewDomain || !state.repo) return null;
    // Pre-auth row (no token) — caller can't talk to the daemon.
    if (!state.daemonToken) return null;
    const rec: FreestyleRecord = {
      id: persisted.id,
      handle: persisted.handle,
      vmId: state.vmId,
      previewDomain: state.previewDomain,
      workdir: state.workdir ?? APP_WORKDIR,
      workload: state.workload ?? null,
      repo: state.repo,
      daemonToken: state.daemonToken,
      daemonBootId: state.daemonBootId ?? randomUUID(),
    };
    this.records.set(handle, rec);
    return rec;
  }

  private async requireRecord(handle: string): Promise<FreestyleRecord> {
    const rec = await this.getRecord(handle);
    if (!rec) throw new Error(`unknown freestyle sandbox handle ${handle}`);
    return rec;
  }

  // ---- Persistence ----------------------------------------------------------

  private async persist(
    ops: RunnerStateStoreOps | null,
    rec: FreestyleRecord,
  ): Promise<void> {
    if (!ops) return;
    const state: PersistedFreestyleState = {
      vmId: rec.vmId,
      previewDomain: rec.previewDomain,
      workdir: rec.workdir,
      workload: rec.workload,
      repo: rec.repo,
      daemonToken: rec.daemonToken,
      daemonBootId: rec.daemonBootId,
    };
    await ops.put(rec.id, RUNNER_KIND, { handle: rec.handle, state });
  }

  // ---- Helpers --------------------------------------------------------------

  private toSandbox(rec: FreestyleRecord): Sandbox {
    return {
      handle: rec.handle,
      workdir: rec.workdir,
      previewUrl: `https://${rec.previewDomain}`,
    };
  }

  /**
   * Stable per-(userId, projectRef, branch) domain key. Format:
   * `<branch-slug>-<hash5>` (or bare hash5 when branch is missing). See
   * `computeHandle` in the shared package for full format details.
   */
  private computeDomainKey(id: SandboxId, branch?: string | null): string {
    return computeHandle(id, branch);
  }

  /**
   * Build a freestyle `VmSpec` from workload + repo. Deterministic — same
   * inputs always produce an equivalent spec, which keeps create-vs-resume
   * spec-comparison stable on freestyle's side.
   */
  private buildSpec({
    repo,
    workload,
    daemonToken,
    daemonBootId,
  }: {
    repo: NonNullable<EnsureOptions["repo"]>;
    workload: Workload | null;
    daemonToken: string;
    daemonBootId: string;
  }): VmSpec {
    const runtime = workload?.runtime ?? "node";
    const packageManager = workload?.packageManager ?? null;
    const devPort = String(workload?.devPort ?? 3000);
    const repoLabel = repo.displayName ?? deriveRepoLabel(repo.cloneUrl);

    const baseSpec = new VmSpec()
      .with("node", new VmNodeJs())
      .with("js", new VmBun())
      .additionalFiles({
        "/opt/sandbox-daemon/daemon.js": { content: DAEMON_BUNDLE_CONTENT },
        "/opt/sandbox-daemon/run.sh": {
          // Source nvm so node + corepack are on PATH for child processes
          // (corepack enable is needed before bun install / pnpm install /
          // yarn install; npm projects need node itself). Bun is the daemon
          // runtime but child processes inherit whatever PATH we set here.
          content:
            "#!/bin/bash\nsource /etc/profile.d/nvm.sh 2>/dev/null || true\nexec /opt/bun/bin/bun /opt/sandbox-daemon/daemon.js\n",
        },
        "/opt/install-ripgrep.sh": {
          content:
            "#!/bin/bash\napt-get update -qq && apt-get install -y -qq ripgrep locales && sed -i 's/^#\\s*en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen\n",
        },
        "/opt/prepare-app-dir.sh": {
          content:
            "#!/bin/bash\nid -u deco &>/dev/null || useradd -m -u 1000 deco\nmkdir -p /app && chown deco:deco /app\n",
        },
      })
      .systemdService({
        name: "install-ripgrep",
        mode: "oneshot",
        exec: ["/bin/bash /opt/install-ripgrep.sh"],
        wantedBy: ["multi-user.target"],
      })
      .systemdService({
        name: "prepare-app-dir",
        mode: "oneshot",
        exec: ["/bin/bash /opt/prepare-app-dir.sh"],
        wantedBy: ["multi-user.target"],
      })
      .systemdService({
        name: "daemon",
        mode: "service",
        exec: ["/bin/bash /opt/sandbox-daemon/run.sh"],
        after: [
          "install-nodejs.service",
          "install-bun.service",
          "install-ripgrep.service",
          "prepare-app-dir.service",
        ],
        requires: [
          "install-nodejs.service",
          "install-bun.service",
          "install-ripgrep.service",
          "prepare-app-dir.service",
        ],
        wantedBy: ["multi-user.target"],
        restartPolicy: { policy: "always", restartSec: 2 },
        env: {
          DAEMON_TOKEN: daemonToken,
          DAEMON_BOOT_ID: daemonBootId,
          CLONE_URL: repo.cloneUrl,
          REPO_NAME: repoLabel,
          BRANCH: repo.branch ?? "",
          GIT_USER_NAME: repo.userName,
          GIT_USER_EMAIL: repo.userEmail,
          PACKAGE_MANAGER: packageManager ?? "",
          DEV_PORT: devPort,
          RUNTIME: runtime,
          APP_ROOT: APP_WORKDIR,
          PROXY_PORT: String(PROXY_PORT),
          DAEMON_DROP_PRIVILEGES: "1",
          // Auto-start when a workload is set; tool sandboxes (no workload)
          // never reach this branch because the freestyle runner only
          // attaches the daemon when there's a repo to clone.
          INTENT: "running",
        },
      });

    return runtime === "deno" ? baseSpec.with("deno", new VmDeno()) : baseSpec;
  }

  /** Same base64 scheme as `proxyDaemonRequest` — parity with exec path. */
  private async postDaemon(
    rec: FreestyleRecord,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const url = `https://${rec.previewDomain}${path}`;
    const encoded = encodeBase64Utf8(JSON.stringify(body));
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        authorization: `Bearer ${rec.daemonToken}`,
      },
      body: encoded,
    });
  }
}

// ---- Helpers ----------------------------------------------------------------

/** stop() + delete() a VM; timebound + errors logged, not thrown. */
async function disposeVm(vmId: string, reason: string): Promise<void> {
  try {
    const vm = freestyle.vms.ref({ vmId });
    await Promise.race([
      vm.stop().then(() => vm.delete()),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("freestyle vm.delete() timed out")),
          DISPOSE_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    console.error(
      `[${LOG_LABEL}] dispose vm ${vmId} (${reason}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function workloadEquals(a: Workload | null, b: Workload | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.runtime === b.runtime &&
    a.packageManager === b.packageManager &&
    a.devPort === b.devPort
  );
}

/** Mirrors the decode path in the daemon's `parseJsonBody`. */
function encodeBase64Utf8(text: string): string {
  return btoa(
    encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16)),
    ),
  );
}

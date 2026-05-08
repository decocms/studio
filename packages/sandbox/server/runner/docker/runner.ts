/**
 * Docker sandbox runner — local dev.
 *
 * One hardened container per (user, projectRef). Daemon + dev ports are
 * published to ephemeral host ports; browser traffic routes through
 * `startLocalSandboxIngress` (`*.localhost`). Mesh owns teardown and sweeps
 * orphans on boot/shutdown.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { DAEMON_PORT, DEFAULT_IMAGE, sleep } from "../../../shared";
import {
  daemonBash,
  postConfig,
  probeDaemonHealth,
  proxyDaemonRequest,
  waitForDaemonReady,
} from "../../daemon-client";
import {
  DEFAULT_WORKDIR,
  dockerExec,
  startContainer,
  type DockerExecFn,
  type DockerResult,
} from "../../docker-cli";
import { ensureSandboxImage } from "../../image-build";
import {
  Inflight,
  applyPreviewPattern,
  buildConfigPayload,
  computeHandle,
  hashSandboxId,
  withSandboxLock,
} from "../shared";
import type { RunnerStateStore, RunnerStateStoreOps } from "../state-store";
import type {
  EnsureOptions,
  ExecInput,
  ExecOutput,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
  SandboxRunner,
  Workload,
} from "../types";
import type { ClaimPhase } from "../lifecycle-types";

const RUNNER_KIND = "docker" as const;
const LABEL_ROOT = "studio-sandbox";
const LABEL_ID = "studio-sandbox.id";
const DEFAULT_DEV_PORT = 3000;
const PORT_READBACK_ATTEMPTS = 15;
const PORT_READBACK_INTERVAL_MS = 200;
const LOG_LABEL = "DockerSandboxRunner";

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

export type ExecResult = DockerResult;
export type DockerExec = DockerExecFn;

export interface DockerRunnerOptions {
  image?: string;
  exec?: DockerExecFn;
  stateStore?: RunnerStateStore;
  previewUrlPattern?: string;
  /** Ownership label; override per mesh instance when multiple share one host. */
  labelPrefix?: string;
}

interface DockerRecord {
  id: SandboxId;
  handle: string;
  token: string;
  workdir: string;
  daemonUrl: string;
  daemonPort: number;
  devPort: number;
  devContainerPort: number;
  workload: Workload | null;
  /**
   * Per-boot UUID the daemon reports on /health. Generated mesh-side and
   * injected via env; re-read from /health on rehydrate so we pick up
   * container restarts.
   */
  daemonBootId: string;
}

interface PersistedDockerState {
  token: string;
  workdir: string;
  daemonUrl: string;
  devPort?: number;
  devContainerPort?: number;
  daemonPort?: number;
  workload?: Workload | null;
  /** Per-boot UUID from the daemon's /health; round-tripped through state. */
  daemonBootId?: string;
  [k: string]: unknown;
}

export class DockerSandboxRunner implements SandboxRunner {
  readonly kind = RUNNER_KIND;

  private readonly records = new Map<string, DockerRecord>();
  private readonly inflight = new Inflight<string, Sandbox>();
  private readonly defaultImage: string;
  private readonly exec_: DockerExecFn;
  private readonly labelPrefix: string;
  private readonly stateStore: RunnerStateStore | null;
  private readonly previewUrlPattern: string | null;

  constructor(opts: DockerRunnerOptions = {}) {
    this.defaultImage =
      opts.image ?? process.env.STUDIO_SANDBOX_IMAGE ?? DEFAULT_IMAGE;
    this.exec_ = opts.exec ?? dockerExec;
    this.labelPrefix = opts.labelPrefix ?? LABEL_ROOT;
    this.stateStore = opts.stateStore ?? null;
    this.previewUrlPattern = opts.previewUrlPattern ?? null;
  }

  // ---- SandboxRunner surface ------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    const labelId = hashSandboxId(id, 16);
    return this.inflight.run(labelId, () =>
      withSandboxLock(this.stateStore, id, RUNNER_KIND, (ops) =>
        this.ensureLocked(id, labelId, opts, ops),
      ),
    );
  }

  async exec(handle: string, input: ExecInput): Promise<ExecOutput> {
    const rec = await this.requireRecord(handle);
    return daemonBash(rec.daemonUrl, rec.token, input);
  }

  async delete(handle: string): Promise<void> {
    const rec = await this.getRecord(handle);
    this.records.delete(handle);
    await this.stopContainer(handle);
    if (this.stateStore) {
      if (rec) await this.stateStore.delete(rec.id, RUNNER_KIND);
      else await this.stateStore.deleteByHandle(RUNNER_KIND, handle);
    }
  }

  async alive(handle: string): Promise<boolean> {
    const r = await this.exec_([
      "inspect",
      "--format",
      "{{.State.Running}}",
      handle,
    ]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    const rec = await this.getRecord(handle);
    return rec ? this.composePreviewUrl(rec) : null;
  }

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
    return proxyDaemonRequest(rec.daemonUrl, rec.token, path, init);
  }

  // No pre-Ready window worth surfacing: VM_START's `runner.ensure` blocks on
  // `waitForDaemonReady`, which returns once the container's daemon `/health`
  // is reachable — typically <1s after `docker run` returns. Yield a single
  // `ready` so the unified vm-events route can proceed straight to the
  // daemon SSE.
  async *watchClaimLifecycle(
    _handle: string,
    _signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    yield { kind: "ready" };
  }

  // ---- Docker-only surface --------------------------------------------------

  async sweepOrphans(): Promise<number> {
    const r = await this.exec_([
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
      "--filter",
      `label=${this.labelPrefix}=1`,
    ]);
    if (r.code !== 0) return 0;
    const handles = r.stdout.trim().split("\n").filter(Boolean);
    await Promise.all(
      handles.map(async (handle) => {
        await this.stopContainer(handle).catch((err) =>
          console.warn(
            `[${LOG_LABEL}] sweep: stopContainer(${handle}) failed:`,
            err instanceof Error ? err.message : String(err),
          ),
        );
        if (this.stateStore) {
          await this.stateStore
            .deleteByHandle(RUNNER_KIND, handle)
            .catch((err) =>
              console.warn(
                `[${LOG_LABEL}] sweep: state-store deleteByHandle(${handle}) failed:`,
                err instanceof Error ? err.message : String(err),
              ),
            );
        }
      }),
    );
    return handles.length;
  }

  /** Docker-only: host port → dev server. Used by local ingress. */
  async resolveDevPort(handle: string): Promise<number | null> {
    const rec = await this.getRecord(handle);
    return rec?.devPort ?? null;
  }

  /** Docker-only: host port → daemon. Used by local ingress. */
  async resolveDaemonPort(handle: string): Promise<number | null> {
    const rec = await this.getRecord(handle);
    return rec?.daemonPort ?? null;
  }

  // ---- Ensure flow ----------------------------------------------------------

  private async ensureLocked(
    id: SandboxId,
    labelId: string,
    opts: EnsureOptions,
    ops: RunnerStateStoreOps | null,
  ): Promise<Sandbox> {
    const log = makePhaseLog(LOG_LABEL);
    log("ensure start", { labelId });
    // 1. State-store resume.
    if (ops) {
      const persisted = await ops.get(id, RUNNER_KIND);
      if (persisted) {
        const rec = await this.rehydrate(id, persisted);
        if (rec) {
          log("ensure ok via=resume", { handle: rec.handle });
          return this.finish(rec, ops, /* persistNow */ false);
        }
        await ops.delete(id, RUNNER_KIND);
        log("resume rejected, falling through");
      }
    }
    // 2. Side-channel adopt: container with our label still running.
    const adopted = await this.adoptByLabel(id, labelId, opts);
    if (adopted) {
      log("ensure ok via=adopt", { handle: adopted.handle });
      return this.finish(adopted, ops, /* persistNow */ true);
    }
    // 3. Fresh provision.
    log("provision start");
    const fresh = await this.provision(id, labelId, opts, log);
    log("ensure ok via=provision", { handle: fresh.handle });
    return this.finish(fresh, ops, /* persistNow */ true);
  }

  private async finish(
    rec: DockerRecord,
    ops: RunnerStateStoreOps | null,
    persistNow: boolean,
  ): Promise<Sandbox> {
    this.records.set(rec.handle, rec);
    if (persistNow) await this.persist(ops, rec);
    return this.toSandbox(rec);
  }

  private async provision(
    id: SandboxId,
    labelId: string,
    opts: EnsureOptions,
    log: PhaseLog,
  ): Promise<DockerRecord> {
    const token = randomBytes(24).toString("hex");
    const daemonBootId = randomUUID();
    const workdir = DEFAULT_WORKDIR;
    const image = opts.image ?? this.defaultImage;
    const devContainerPort = opts.workload?.devPort ?? DEFAULT_DEV_PORT;

    // Bootstrap-only env: identity + ports. Repo + workload are pushed via
    // POST /_decopilot_vm/config after the daemon is healthy. opts.env is
    // spread last to match the host runner's escape-hatch semantics —
    // overriding daemon bootstrap names is rare and breaks things, but the
    // hatch stays.
    const env: Record<string, string> = {
      DAEMON_TOKEN: token,
      DAEMON_BOOT_ID: daemonBootId,
      APP_ROOT: workdir,
      PROXY_PORT: String(DAEMON_PORT),
      ...(opts.env ?? {}),
    };
    const configPayload = buildConfigPayload({
      runtime: opts.workload?.runtime ?? "node",
      packageManager: opts.workload?.packageManager
        ? {
            name: opts.workload.packageManager,
            ...(opts.workload.packageManagerPath
              ? { path: opts.workload.packageManagerPath }
              : {}),
          }
        : null,
      repo: opts.repo ?? null,
      port: devContainerPort,
    });

    // Shared singleton; awaits any background build kicked off by the CLI.
    log("ensureSandboxImage start");
    await ensureSandboxImage({
      image,
      exec: this.exec_,
      onLog: (line) => log("image build", { line }),
    });
    log("ensureSandboxImage ok");

    // Hardening: drop caps + block privilege escalation; cap processes/memory/
    // cpu against runaway user scripts. Read-only root removes most write-based
    // pivots; /tmp is a bounded tmpfs; /app and /home/sandbox are anonymous
    // volumes (disk-backed) so package-manager caches don't blow the mem cap.
    const handle = computeHandle(id, opts.repo?.branch);
    const tryStart = () =>
      startContainer(image, {
        label: "sandbox",
        exec: this.exec_,
        args: [
          "--name",
          handle,
          "--rm",
          "--init",
          "--read-only",
          "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
          "-v",
          "/app",
          "-v",
          "/home/sandbox",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=512",
          "--memory=2g",
          "--memory-swap=2g",
          "--cpus=1",
          "--label",
          `${this.labelPrefix}=1`,
          "--label",
          `${LABEL_ID}=${labelId}`,
          "-p",
          `127.0.0.1:0:${DAEMON_PORT}`,
          "-p",
          `127.0.0.1:0:${devContainerPort}`,
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        ],
      });

    log("docker run start", { handle, image });
    try {
      await tryStart();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // findExisting only adopts *running* containers via `docker ps`, so a
      // stopped same-name orphan left behind by a crash that bypassed --rm
      // cleanup will collide on `--name`. Force-remove the orphan and retry
      // once; if the retry still fails, surface the original error.
      if (msg.includes("is already in use")) {
        log("docker run name conflict, retrying after rm", { handle });
        await this.exec_(["rm", "-f", handle]).catch(() => undefined);
        await tryStart();
      } else {
        throw err;
      }
    }
    log("docker run ok", { handle });

    const daemonPort = await this.readPort(handle, DAEMON_PORT);
    const daemonUrl = `http://127.0.0.1:${daemonPort}`;
    const devPort = await this.readPort(handle, devContainerPort);
    log("ports read", { daemonPort, devPort });
    log("waitForDaemonReady start", { daemonUrl });
    try {
      await waitForDaemonReady(daemonUrl);
      if (configPayload) {
        log("postConfig start", { daemonUrl });
        await postConfig(daemonUrl, token, configPayload);
        log("postConfig ok");
      }
    } catch (err) {
      log("waitForDaemonReady failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      await this.stopContainer(handle).catch((stopErr) =>
        console.warn(
          `[${LOG_LABEL}] cleanup stop after waitForDaemonReady failure (${handle}) itself failed:`,
          stopErr instanceof Error ? stopErr.message : String(stopErr),
        ),
      );
      throw err;
    }
    log("daemon ready", { handle });
    return {
      id,
      handle,
      token,
      workdir,
      daemonUrl,
      daemonPort,
      devPort,
      devContainerPort,
      workload: opts.workload ?? null,
      daemonBootId,
    };
  }

  /**
   * Reconstruct a record from persisted state, probing that the container is
   * still healthy. Returns null on any mismatch — caller purges and falls
   * through to `adoptByLabel`/`provision`.
   */
  private async rehydrate(
    id: SandboxId,
    persisted: { handle: string; state: Record<string, unknown> },
  ): Promise<DockerRecord | null> {
    const state = persisted.state as Partial<PersistedDockerState>;
    if (!state.token || !state.daemonUrl) return null;
    const handle = persisted.handle;
    const devContainerPort = state.devContainerPort ?? DEFAULT_DEV_PORT;
    let daemonPort: number;
    let devPort: number;
    try {
      daemonPort = await this.readPort(handle, DAEMON_PORT);
      devPort = await this.readPort(handle, devContainerPort);
    } catch {
      return null;
    }
    const daemonUrl = `http://127.0.0.1:${daemonPort}`;
    // probeDaemonHealth returns null when /health is unreachable OR when the
    // response lacks a bootId — the latter covers a running container still
    // on the pre-unified daemon.mjs ({ ok: true } shape). In either case the
    // caller purges this record + adopts or reprovisions from scratch.
    const health = await probeDaemonHealth(daemonUrl);
    if (!health) return null;
    // When the live bootId differs from our persisted one, the container
    // bounced but /app survived. The unified daemon's orchestrator handles
    // this itself on boot (resume-on-restart). We just refresh our copy of
    // bootId here; no force-recreate needed.
    if (state.daemonBootId && state.daemonBootId !== health.bootId) {
      console.warn(
        `[${LOG_LABEL}] daemon restart detected (handle=${handle}): stored bootId=${state.daemonBootId} live bootId=${health.bootId}`,
      );
    }
    return {
      id,
      handle,
      token: state.token,
      workdir: state.workdir ?? DEFAULT_WORKDIR,
      daemonUrl,
      daemonPort,
      devPort,
      devContainerPort,
      daemonBootId: health.bootId,
      workload: state.workload ?? null,
    };
  }

  /**
   * State store empty but a container with our label still runs. Reconstruct
   * from `docker inspect` env vars; tear down anything we can't reuse so
   * `provision` below doesn't collide on the next ensure.
   */
  private async adoptByLabel(
    id: SandboxId,
    labelId: string,
    opts: EnsureOptions,
  ): Promise<DockerRecord | null> {
    const existing = await this.findExisting(labelId);
    if (!existing) return null;

    const cached = this.records.get(existing);
    if (cached) return cached;

    const recovered = await this.reconstructFromContainer(id, existing, opts);
    if (recovered) return recovered;

    await this.stopContainer(existing);
    return null;
  }

  private async reconstructFromContainer(
    id: SandboxId,
    handle: string,
    opts: EnsureOptions,
  ): Promise<DockerRecord | null> {
    const r = await this.exec_([
      "inspect",
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
      handle,
    ]);
    if (r.code !== 0) return null;
    let token: string | null = null;
    let workdir = DEFAULT_WORKDIR;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("DAEMON_TOKEN=")) token = line.slice(13);
      else if (line.startsWith("APP_ROOT=")) workdir = line.slice(9);
    }
    if (!token) return null;
    const daemonPort = await this.readPort(handle, DAEMON_PORT);
    const daemonUrl = `http://127.0.0.1:${daemonPort}`;
    const health = await probeDaemonHealth(daemonUrl);
    if (!health) return null;
    const devContainerPort = opts.workload?.devPort ?? DEFAULT_DEV_PORT;
    const devPort = await this.readPort(handle, devContainerPort);
    return {
      id,
      handle,
      token,
      workdir,
      daemonUrl,
      daemonPort,
      devPort,
      devContainerPort,
      daemonBootId: health.bootId,
      workload: opts.workload ?? null,
    };
  }

  // ---- Handle resolution (post-restart) -------------------------------------

  /**
   * Look up a record by handle, rehydrating from persisted state on cache
   * miss. The returned record is fully usable for any of the six methods —
   * after a mesh restart this is the entry point that reconstructs state.
   */
  private async getRecord(handle: string): Promise<DockerRecord | null> {
    const cached = this.records.get(handle);
    if (cached) return cached;
    if (!this.stateStore) return null;
    const persisted = await this.stateStore.getByHandle(RUNNER_KIND, handle);
    if (!persisted) return null;
    const rec = await this.rehydrate(persisted.id, persisted);
    if (rec) this.records.set(handle, rec);
    return rec;
  }

  private async requireRecord(handle: string): Promise<DockerRecord> {
    const rec = await this.getRecord(handle);
    if (!rec) throw new Error(`unknown sandbox handle ${handle}`);
    return rec;
  }

  // ---- Preview URL ----------------------------------------------------------

  /**
   * Local-ingress preview URL. Docker's URL is derived purely from the handle,
   * not gated on workload — the dev server may boot from a caller workload
   * hint OR the daemon auto-sniffing package.json / deno.json.
   */
  private composePreviewUrl(rec: DockerRecord): string {
    if (this.previewUrlPattern) {
      return applyPreviewPattern(this.previewUrlPattern, rec.handle);
    }
    const envRoot = process.env.SANDBOX_ROOT_URL;
    if (envRoot) return applyPreviewPattern(envRoot, rec.handle);
    const ingressPort = Number(process.env.SANDBOX_INGRESS_PORT ?? 7070);
    return `http://${rec.handle}.localhost:${ingressPort}/`;
  }

  private toSandbox(rec: DockerRecord): Sandbox {
    return {
      handle: rec.handle,
      workdir: rec.workdir,
      previewUrl: this.composePreviewUrl(rec),
    };
  }

  // ---- Persistence ----------------------------------------------------------

  private async persist(
    ops: RunnerStateStoreOps | null,
    rec: DockerRecord,
  ): Promise<void> {
    if (!ops) return;
    const state: PersistedDockerState = {
      token: rec.token,
      workdir: rec.workdir,
      daemonUrl: rec.daemonUrl,
      daemonPort: rec.daemonPort,
      devPort: rec.devPort,
      devContainerPort: rec.devContainerPort,
      workload: rec.workload,
      daemonBootId: rec.daemonBootId,
    };
    await ops.put(rec.id, RUNNER_KIND, { handle: rec.handle, state });
  }

  // ---- Docker CLI helpers ---------------------------------------------------

  private async stopContainer(handle: string): Promise<void> {
    await this.exec_(["stop", "--time", "2", handle]);
  }

  private async findExisting(labelId: string): Promise<string | null> {
    const r = await this.exec_([
      "ps",
      "--no-trunc",
      "--format",
      "{{.Names}}",
      "--filter",
      `label=${LABEL_ID}=${labelId}`,
    ]);
    if (r.code !== 0) return null;
    const name = r.stdout.trim().split("\n").filter(Boolean)[0];
    return name ?? null;
  }

  private async readPort(
    handle: string,
    containerPort: number,
  ): Promise<number> {
    for (let i = 0; i < PORT_READBACK_ATTEMPTS; i++) {
      const r = await this.exec_(["port", handle, `${containerPort}/tcp`]);
      if (r.code === 0) {
        for (const line of r.stdout.split("\n")) {
          const match = line.trim().match(/:(\d+)$/);
          if (match) return Number(match[1]);
        }
      } else if (/no such container/i.test(r.stderr)) {
        const diag = await this.exitDiagnostics(handle);
        throw new Error(
          `sandbox container ${handle} exited before daemon started${diag}`,
        );
      }
      await sleep(PORT_READBACK_INTERVAL_MS);
    }
    throw new Error(
      `timed out waiting for docker port mapping on container ${handle}`,
    );
  }

  private async exitDiagnostics(handle: string): Promise<string> {
    const parts: string[] = [];
    const inspect = await this.exec_([
      "inspect",
      "--format",
      "{{.State.ExitCode}}",
      handle,
    ]);
    if (inspect.code === 0 && inspect.stdout.trim()) {
      parts.push(`exit=${inspect.stdout.trim()}`);
    }
    const logs = await this.exec_(["logs", "--tail", "20", handle]);
    const tail = [logs.stdout, logs.stderr]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (tail) parts.push(`logs:\n${tail}`);
    return parts.length ? ` (${parts.join(" ")})` : "";
  }
}

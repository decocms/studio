/**
 * `SandboxProvider` on Freestyle VMs (https://freestyle.sh). Each sandbox is
 * one VM running the same `studio-sandbox-go` image a pod runs, under Docker,
 * with the daemon's port published at `https://<handle>.<domainSuffix>`.
 *
 * The VM is the whole state: its slug is the handle and its metadata holds the
 * daemon bearer, so any Studio replica can find a sandbox without a database.
 * An idle VM is paused, and traffic to its domain resumes it; one paused for
 * `autoDeleteSeconds` is deleted.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Meter } from "@opentelemetry/api";
import {
  type CreateVmOptions,
  Freestyle,
  FreestyleApiError,
  type Vm,
} from "freestyle";
import { sleep } from "@decocms/shared/std";
import pkg from "../../package.json" with { type: "json" };
import { postConfig, postOrgFsConfig } from "../daemon-client";
import type { SandboxProvider } from "./agent-sandbox";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import {
  buildConfigPayload,
  computeHandle,
  gitCredentialRefreshPatch,
  Inflight,
} from "./shared";
import {
  type DaemonAddress,
  proxyDaemonWithRetry,
} from "./shared/daemon-proxy";
import { proxyPreview } from "./shared/preview-proxy";
import { daemonProxyTimer, RUNNER_KIND } from "./shared/proxy-metrics";
import type {
  EnsureOptions,
  PodTermination,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
} from "./types";

const LOG_LABEL = "FreestyleSandboxProvider";

const DAEMON_PORT = 9000;
const WORKDIR = "/app";
const DEFAULT_DEV_PORT = 3000;
const CONTAINER = "sandbox";
const SIDECAR = "orgfs";
/** Track `orgFs.image.tag` in deploy/helm/sandbox-env/values.yaml. */
const DEFAULT_SIDECAR_IMAGE = "ghcr.io/decocms/studio/orgfs-sidecar:0.2.0";
/** Host dirs standing in for the pod's `orgfs-org` and `orgfs-ctl` volumes. */
const HOST_ORG_DIR = "/srv/sandbox/org";
const HOST_CTL_DIR = "/srv/sandbox/orgfs-ctl";
const CTL_DIR = "/run/orgfs";
/**
 * fstab, so both come back before Docker restarts the containers after a
 * reboot. The org dir is shared so the sidecar's FUSE mounts reach the
 * sandbox container. The ctl dir is tmpfs: a reboot drops the old
 * status.json with the mounts it lists, and `resume` relays the config anew.
 */
const HOST_SETUP = [
  `mkdir -p ${HOST_ORG_DIR} ${HOST_CTL_DIR}`,
  `grep -q ' ${HOST_ORG_DIR} ' /etc/fstab || printf '%s\\n' '${HOST_ORG_DIR} ${HOST_ORG_DIR} none bind,rshared 0 0' 'tmpfs ${HOST_CTL_DIR} tmpfs uid=1000,gid=1000,mode=0755,size=1m 0 0' >> /etc/fstab`,
  `mountpoint -q ${HOST_ORG_DIR} || mount ${HOST_ORG_DIR}`,
  `mountpoint -q ${HOST_CTL_DIR} || mount ${HOST_CTL_DIR}`,
].join(" && ");
/** Metadata keys; values are capped at 63 chars, which the 48-hex token fits. */
const TOKEN_KEY = "studio-daemon-token";
const ORG_KEY = "studio-org-id";
const USER_KEY = "studio-user-id";

/** The daemon answers within seconds of boot; this bounds a VM that never serves. */
const DAEMON_BOOT_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 500;
/** Each probe crosses the public edge, not a cluster hop. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;
/** Pulling the image into a fresh VM took ~50s in testing. */
const IMAGE_PULL_TIMEOUT_MS = 300_000;
const LOOKUP_TTL_MS = 5 * 60_000;
/** Short, so a sandbox another replica just created is found soon. */
const MISS_TTL_MS = 10_000;
const LOOKUP_MAX = 5_000;
const WATCH_TIMEOUT_MS = 5 * 60_000;
/** Lookups sit on every uncached handle-only call, Kubernetes ones included. */
const LOOKUP_TIMEOUT_MS = 3_000;

export interface FreestyleSandboxProviderOptions {
  apiKey: string;
  /** The sandbox image. Default: the release built from this package's version. */
  image?: string;
  /** The org-fs sidecar image. Default: the chart's `orgFs.image`. */
  orgFsSidecarImage?: string;
  /** Pause a VM after this long without network activity. Default 5 min. */
  idleTimeoutSeconds?: number;
  /**
   * Delete a VM after this long without running. Default 1 hour. A plan
   * that caps it lower gets its cap.
   */
  autoDeleteSeconds?: number;
  /** Where daemon ports are published. Default `style.dev`, free on every account. */
  domainSuffix?: string;
  /** Records daemon request latency; see `daemonProxyTimer`. */
  meter?: Meter;
  /** Replaces the API client, for tests. */
  client?: Freestyle;
}

interface Found {
  vm: Vm;
  daemon: DaemonAddress;
}

export class FreestyleSandboxProvider implements SandboxProvider {
  private readonly freestyle: Freestyle;
  private readonly lookupClient: Freestyle;
  private readonly image: string;
  private readonly sidecarImage: string;
  private readonly idleTimeoutSeconds: number;
  private readonly autoDeleteSeconds: number;

  private readonly domainSuffix: string;
  private readonly timeDaemonRequest: ReturnType<typeof daemonProxyTimer>;
  private readonly inflight = new Inflight<string, Sandbox>();
  private readonly snapshotInflight = new Inflight<string, string>();
  private readonly lookups = new Map<
    string,
    { found: Found | null; at: number }
  >();
  private readonly releaseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(opts: FreestyleSandboxProviderOptions) {
    this.freestyle = opts.client ?? new Freestyle({ apiKey: opts.apiKey });
    this.lookupClient =
      opts.client ??
      new Freestyle({
        apiKey: opts.apiKey,
        fetch: Object.assign(
          (input: RequestInfo | URL, init?: RequestInit) =>
            fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([
                    init.signal,
                    AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
                  ])
                : AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
            }),
          { preconnect: fetch.preconnect },
        ),
      });
    this.image =
      opts.image ?? `ghcr.io/decocms/studio/studio-sandbox-go:${pkg.version}`;
    this.sidecarImage = opts.orgFsSidecarImage ?? DEFAULT_SIDECAR_IMAGE;
    this.idleTimeoutSeconds = opts.idleTimeoutSeconds ?? 5 * 60;
    this.autoDeleteSeconds = opts.autoDeleteSeconds ?? 60 * 60;
    this.domainSuffix = opts.domainSuffix ?? "style.dev";
    this.timeDaemonRequest = daemonProxyTimer(opts.meter);
  }

  /** Whether this handle is a Freestyle sandbox. Cached; see `MISS_TTL_MS`. */
  async owns(handle: string): Promise<boolean> {
    return (await this.find(handle)) !== null;
  }

  // ---- Lookup ---------------------------------------------------------------

  private daemonUrl(handle: string): string {
    return `https://${handle}.${this.domainSuffix}`;
  }

  private async find(
    handle: string,
    opts: { refresh?: boolean } = {},
  ): Promise<Found | null> {
    const hit = this.lookups.get(handle);
    if (
      !opts.refresh &&
      hit &&
      Date.now() - hit.at < (hit.found ? LOOKUP_TTL_MS : MISS_TTL_MS)
    ) {
      return hit.found;
    }
    let found: Found | null = null;
    try {
      const data = await this.lookupClient.vms.get(handle);
      const token = data.metadata[TOKEN_KEY];
      // A VM without our token is someone else's that happens to share the slug.
      if (token) {
        found = {
          vm: this.freestyle.vms.ref(data.id),
          daemon: { url: this.daemonUrl(handle), token },
        };
      }
    } catch (err) {
      if (!(err instanceof FreestyleApiError && err.status === 404)) throw err;
    }
    this.remember(handle, found);
    return found;
  }

  private remember(handle: string, found: Found | null): void {
    this.lookups.delete(handle);
    if (this.lookups.size >= LOOKUP_MAX) {
      const oldest = this.lookups.keys().next();
      if (!oldest.done) this.lookups.delete(oldest.value);
    }
    this.lookups.set(handle, { found, at: Date.now() });
  }

  // ---- Base snapshot --------------------------------------------------------

  /**
   * A snapshot of a VM with both images already pulled, so a sandbox boots in
   * seconds instead of pulling ~2GB. One per image pair; built on first use.
   */
  private baseSnapshot(): Promise<string> {
    const { image, sidecarImage } = this;
    const slug = `studio-sandbox-${createHash("sha256").update(`${image}\n${sidecarImage}`).digest("hex").slice(0, 16)}`;
    return this.snapshotInflight.run(slug, async () => {
      if (await this.snapshotExists(slug)) return slug;
      console.log(`[${LOG_LABEL}] building base snapshot ${slug} for ${image}`);
      const { vm } = await this.freestyle.vms.create({
        ttlSeconds: 1800,
        firewall: {
          rules: [
            { action: "allow", source: {}, destination: { public: true } },
          ],
        },
      });
      try {
        await this.run(
          vm,
          `docker pull -q ${shellQuote(image)} && docker pull -q ${shellQuote(sidecarImage)}`,
          { timeoutMs: IMAGE_PULL_TIMEOUT_MS },
        );
        await vm.snapshot({ slug });
      } catch (err) {
        // Another replica took the slug first: theirs serves just as well.
        if (!(await this.snapshotExists(slug))) throw err;
      } finally {
        await vm.delete().catch(() => {});
      }
      return slug;
    });
  }

  private async snapshotExists(slug: string): Promise<boolean> {
    try {
      await this.freestyle.vms.snapshots.get(slug);
      return true;
    } catch (err) {
      if (err instanceof FreestyleApiError && err.status === 404) return false;
      throw err;
    }
  }

  private async run(
    vm: Vm,
    command: string,
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<string> {
    const res = await vm.exec({ command, ...opts });
    if (res.statusCode !== 0) {
      throw new Error(
        `${command.split(" ", 2).join(" ")} failed (${res.statusCode ?? "timeout"}): ${(res.stderr || res.stdout || "").slice(-500)}`,
      );
    }
    return res.stdout ?? "";
  }

  // ---- Lifecycle ------------------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    const handle = computeHandle(id);
    if (handle.startsWith("s-")) {
      throw new Error(
        `ensure: projectRef has no slug source: ${id.projectRef}`,
      );
    }
    return this.inflight.run(handle, async () => {
      this.cancelRelease(handle);
      const existing = await this.find(handle, { refresh: true });
      if (existing) {
        await this.resume(existing, opts);
      } else {
        await this.create(handle, opts);
      }
      return {
        handle,
        workdir: WORKDIR,
        previewUrl: this.daemonUrl(handle),
        warmPoolAdopted: false,
        provider: "freestyle",
      };
    });
  }

  private async resume(found: Found, opts: EnsureOptions): Promise<void> {
    const { state } = await found.vm.data();
    if (state !== "running") await found.vm.start();
    await this.waitForDaemon(found.daemon.url);
    // A rebooted VM lost its mounts with the tmpfs ctl dir. A mounted sidecar
    // ignores the rewrite, and the daemon takes the fresh token either way.
    if (opts.orgFsConfigJson) {
      await postOrgFsConfig(
        found.daemon.url,
        found.daemon.token,
        opts.orgFsConfigJson,
      ).catch((err) => console.warn(`[${LOG_LABEL}] org-fs relay failed`, err));
    }
    const patch = gitCredentialRefreshPatch(opts);
    if (patch) {
      await postConfig(found.daemon.url, found.daemon.token, patch).catch(
        (err) =>
          console.warn(
            `[${LOG_LABEL}] git credential refresh failed: ${errMsg(err)}`,
          ),
      );
    }
  }

  private async create(handle: string, opts: EnsureOptions): Promise<void> {
    const snapshotId = await this.baseSnapshot();
    const token = randomBytes(24).toString("hex");
    const { vm } = await this.createVm({
      snapshotId,
      slug: handle,
      idleTimeoutSeconds: this.idleTimeoutSeconds,
      metadata: {
        [TOKEN_KEY]: token,
        ...(opts.tenant
          ? { [ORG_KEY]: opts.tenant.orgId, [USER_KEY]: opts.tenant.userId }
          : {}),
      },
      firewall: {
        rules: [{ action: "allow", source: {}, destination: { public: true } }],
      },
      tls: {
        rules: [
          {
            action: "allow",
            domain: `${handle}.${this.domainSuffix}`,
            source: { public: true },
            destination: { port: DAEMON_PORT },
          },
        ],
      },
    });
    const daemon = { url: this.daemonUrl(handle), token };
    try {
      const env: Record<string, string> = {
        ...opts.env,
        DAEMON_TOKEN: token,
        DAEMON_BOOT_ID: crypto.randomUUID(),
        APP_ROOT: WORKDIR,
        PROXY_PORT: String(DAEMON_PORT),
        ORGFS_SIDECAR_CONFIG_PATH: `${CTL_DIR}/config.json`,
        ORGFS_SIDECAR_STATUS_PATH: `${CTL_DIR}/status.json`,
      };
      // Bare `-e NAME` copies each value from the exec's env, keeping values out of the shell line.
      const envFlags = Object.keys(env)
        .map((k) => `-e ${shellQuote(k)}`)
        .join(" ");
      // The sidecar first: it only polls for the config the daemon relays.
      // Its change-feed poll is network activity, which keeps a VM from
      // pausing, so it stops once the daemon has been idle for a minute.
      await this.run(
        vm,
        `sudo sh -c ${shellQuote(HOST_SETUP)} && docker run -d --name ${SIDECAR} --restart=always --privileged --device /dev/fuse -e APP_ROOT=${WORKDIR} -e ORGFS_FEED_IDLE_MS=60000 -v ${HOST_ORG_DIR}:${WORKDIR}/org:rshared -v ${HOST_CTL_DIR}:${CTL_DIR} ${shellQuote(this.sidecarImage)}`,
        { timeoutMs: IMAGE_PULL_TIMEOUT_MS },
      );
      await this.run(
        vm,
        `docker run -d --name ${CONTAINER} --restart=always -p ${DAEMON_PORT}:${DAEMON_PORT} -v ${HOST_ORG_DIR}:${WORKDIR}/org:rslave -v ${HOST_CTL_DIR}:${CTL_DIR} ${envFlags} ${shellQuote(this.image)}`,
        { env, timeoutMs: IMAGE_PULL_TIMEOUT_MS },
      );
      await this.waitForDaemon(daemon.url);
      await postConfig(daemon.url, token, this.configPayload(opts) ?? {});
      if (opts.orgFsConfigJson) {
        await postOrgFsConfig(daemon.url, token, opts.orgFsConfigJson).catch(
          (err) => console.warn(`[${LOG_LABEL}] org-fs relay failed`, err),
        );
      }
    } catch (err) {
      await vm.delete().catch(() => {});
      this.lookups.delete(handle);
      throw err;
    }
    this.remember(handle, { vm, daemon });
  }

  /** A plan that caps autoDelete lower answers 400; omitting it gets the cap. */
  private async createVm(
    opts: Omit<CreateVmOptions, "autoDeleteSeconds">,
  ): ReturnType<Freestyle["vms"]["create"]> {
    try {
      return await this.freestyle.vms.create({
        ...opts,
        autoDeleteSeconds: this.autoDeleteSeconds,
      });
    } catch (err) {
      if (!(err instanceof FreestyleApiError && err.status === 400)) throw err;
      console.warn(
        `[${LOG_LABEL}] autoDeleteSeconds=${this.autoDeleteSeconds} refused (${err.message}); creating with the plan's cap`,
      );
      return this.freestyle.vms.create(opts);
    }
  }

  private configPayload(opts: EnsureOptions) {
    return buildConfigPayload({
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
      extraRepos: opts.extraRepos ?? [],
      port: opts.workload?.devPort ?? DEFAULT_DEV_PORT,
      tenant: opts.tenant,
      cloneOnly: opts.cloneOnly === true,
    });
  }

  private async waitForDaemon(url: string): Promise<void> {
    const deadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await daemonAnswers(url)) return;
      await sleep(HEALTH_POLL_MS);
    }
    throw new Error(
      `sandbox daemon at ${url} did not answer /health within ${DAEMON_BOOT_TIMEOUT_MS / 1000}s`,
    );
  }

  async delete(handle: string): Promise<void> {
    this.cancelRelease(handle);
    const found = await this.find(handle, { refresh: true });
    this.lookups.delete(handle);
    if (!found) return;
    // SIGTERM first: the daemon publishes unsaved work to git on shutdown.
    // Then the sidecar, which detaches and flushes its mounts.
    await found.vm
      .exec({
        command: `docker stop -t 30 ${CONTAINER}; docker stop -t 10 ${SIDECAR}`,
        timeoutMs: 60_000,
      })
      .catch(() => {});
    await found.vm.delete();
  }

  async lastTermination(_handle: string): Promise<PodTermination | null> {
    return null;
  }

  /** A paused VM is alive: the next request resumes it. */
  async alive(handle: string): Promise<boolean> {
    return (await this.find(handle, { refresh: true })) !== null;
  }

  /** `ensure` only returns once the daemon answers, so this only has to see that. */
  async *watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    const since = Date.now();
    yield { kind: "claiming", since };
    let announced = false;
    while (!signal?.aborted) {
      const found = await this.find(handle, { refresh: true }).catch(
        () => null,
      );
      if (found) {
        if (!announced) {
          announced = true;
          yield { kind: "warming-daemon", since: Date.now() };
        }
        if (await daemonAnswers(found.daemon.url)) {
          yield { kind: "ready" };
          return;
        }
      }
      if (Date.now() - since > WATCH_TIMEOUT_MS) {
        yield {
          kind: "failed",
          reason: found ? "crash-loop-backoff" : "claim-never-created",
          message: found
            ? "the sandbox VM exists but its daemon never answered"
            : "no sandbox VM was created",
        };
        return;
      }
      await sleep(1_000);
    }
  }

  async hasSchedulableCapacity(): Promise<boolean> {
    return true;
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    return (await this.find(handle)) ? this.daemonUrl(handle) : null;
  }

  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    const found = await this.find(handle);
    if (!found) {
      return Response.json({ error: "sandbox not found" }, { status: 404 });
    }
    const reread = async () =>
      (await this.find(handle, { refresh: true }))?.daemon ?? null;
    return this.timeDaemonRequest(RUNNER_KIND.freestyle, () =>
      proxyDaemonWithRetry(found.daemon, path, init, {
        unauthorized: async () => {
          const fresh = await reread();
          return fresh && fresh.token !== found.daemon.token ? fresh : null;
        },
        unreachable: reread,
      }),
    );
  }

  /** The daemon's public address and bearer, for a host serving `sandbox-api`. */
  async daemonEndpoint(handle: string): Promise<DaemonAddress | null> {
    return (await this.find(handle))?.daemon ?? null;
  }

  async adoptLiveClaim(_id: SandboxId, handle: string): Promise<boolean> {
    return (await this.find(handle, { refresh: true })) !== null;
  }

  async resolvePreviewUpstreamUrl(handle: string): Promise<string | null> {
    return (await this.find(handle))?.daemon.url ?? null;
  }

  proxyPreviewRequest(handle: string, request: Request): Promise<Response> {
    return proxyPreview(
      request,
      {
        base: () => this.resolvePreviewUpstreamUrl(handle).catch(() => null),
        invalidate: () => this.lookups.delete(handle),
        retryBase: () =>
          this.find(handle, { refresh: true })
            .then((f) => f?.daemon.url ?? null)
            .catch(() => null),
      },
      LOG_LABEL,
    );
  }

  async markTenantPoolsDirty(
    _repoUrl: string,
    _ref: string,
  ): Promise<string[]> {
    return [];
  }

  /**
   * Pause after `graceMs`. Pausing keeps memory and disk, so this costs the
   * sandbox nothing but a resume.
   *
   * ponytail: in-process timer, lost on restart; the idle timeout pauses the
   * VM anyway, only later.
   */
  async releaseAfter(handle: string, graceMs: number): Promise<void> {
    this.cancelRelease(handle);
    const timer = setTimeout(() => {
      this.releaseTimers.delete(handle);
      void this.find(handle)
        .then((f) => f?.vm.pause())
        .catch((err) =>
          console.warn(`[${LOG_LABEL}] pause ${handle} failed: ${errMsg(err)}`),
        );
    }, graceMs);
    timer.unref?.();
    this.releaseTimers.set(handle, timer);
  }

  /** The VM's idle timeout already counts every request as activity. */
  async renewTtl(handle: string): Promise<void> {
    this.cancelRelease(handle);
  }

  private cancelRelease(handle: string): void {
    const timer = this.releaseTimers.get(handle);
    if (timer) clearTimeout(timer);
    this.releaseTimers.delete(handle);
  }

  close(): void {
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    this.lookups.clear();
  }
}

async function daemonAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

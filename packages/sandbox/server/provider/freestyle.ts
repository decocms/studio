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
const IMAGE_RECHECK_MS = 5 * 60_000;
const IMAGE_CHECK_TIMEOUT_MS = 10_000;

export interface FreestyleSandboxProviderOptions {
  apiKey: string;
  /** The sandbox image. Default: the release built from this package's version. */
  image?: string;
  /** Pause a VM after this long without network activity. Default 15 min. */
  idleTimeoutSeconds?: number;
  /**
   * Delete a VM after this long without running. Default 3 days. A plan
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
  private readonly idleTimeoutSeconds: number;
  private readonly autoDeleteSeconds: number;
  private imageFound = true;
  private imageRecheck: ReturnType<typeof setTimeout> | undefined;
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
    this.idleTimeoutSeconds = opts.idleTimeoutSeconds ?? 15 * 60;
    this.autoDeleteSeconds = opts.autoDeleteSeconds ?? 3 * 24 * 60 * 60;
    this.domainSuffix = opts.domainSuffix ?? "style.dev";
    this.timeDaemonRequest = daemonProxyTimer(opts.meter);
    opts.meter
      ?.createObservableGauge("studio.sandbox.freestyle.image_available", {
        description:
          "1 while the Freestyle sandbox image exists in its registry; 0 stops new Freestyle placements.",
      })
      .addCallback((result) =>
        result.observe(this.imageFound ? 1 : 0, { image: this.image }),
      );
    void this.checkImage();
  }

  /** Whether this handle is a Freestyle sandbox. Cached; see `MISS_TTL_MS`. */
  async owns(handle: string): Promise<boolean> {
    return (await this.find(handle)) !== null;
  }

  /** False while the image is missing from its registry: every create would fail. */
  available(): boolean {
    return this.imageFound;
  }

  /** Only a registry's definite "no such tag" counts; an unreachable one doesn't stop placements. */
  private async checkImage(): Promise<void> {
    const found = await imageExists(this.image).catch((err: unknown) => {
      console.warn(
        `[${LOG_LABEL}] could not check image ${this.image}: ${errMsg(err)}`,
      );
      return true;
    });
    if (found !== this.imageFound) {
      if (found) {
        console.log(`[${LOG_LABEL}] image ${this.image} found`);
      } else {
        console.error(
          `[${LOG_LABEL}] image ${this.image} does not exist; placing no new sandboxes on Freestyle until it does`,
        );
      }
    }
    this.imageFound = found;
    if (!found) {
      this.imageRecheck = setTimeout(
        () => void this.checkImage(),
        IMAGE_RECHECK_MS,
      );
      this.imageRecheck.unref?.();
    }
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
   * A snapshot of a VM with the image already pulled, so a sandbox boots in
   * seconds instead of pulling ~2GB. One per image; built on first use.
   */
  private baseSnapshot(): Promise<string> {
    const image = this.image;
    const slug = `studio-sandbox-${createHash("sha256").update(image).digest("hex").slice(0, 16)}`;
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
        await this.run(vm, `docker pull -q ${shellQuote(image)}`, {
          timeoutMs: IMAGE_PULL_TIMEOUT_MS,
        });
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
      };
      // Bare `-e NAME` copies each value from the exec's env, keeping values out of the shell line.
      const envFlags = Object.keys(env)
        .map((k) => `-e ${shellQuote(k)}`)
        .join(" ");
      await this.run(
        vm,
        `docker run -d --name ${CONTAINER} --restart=always -p ${DAEMON_PORT}:${DAEMON_PORT} ${envFlags} ${shellQuote(this.image)}`,
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
    await found.vm
      .exec({ command: `docker stop -t 30 ${CONTAINER}`, timeoutMs: 45_000 })
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
    clearTimeout(this.imageRecheck);
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

/** HEAD on the image's manifest, anonymously. Only ghcr.io is checked. */
async function imageExists(image: string): Promise<boolean> {
  const match = /^ghcr\.io\/([^:@]+):([^:@/]+)$/.exec(image);
  if (!match) return true;
  const [, repo, tag] = match;
  const signal = AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS);
  const auth = await fetch(
    `https://ghcr.io/token?scope=repository:${repo}:pull`,
    { signal },
  );
  if (!auth.ok) throw new Error(`ghcr token ${auth.status}`);
  const { token } = (await auth.json()) as { token?: string };
  const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
    method: "HEAD",
    signal,
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`ghcr manifest ${res.status}`);
  return true;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

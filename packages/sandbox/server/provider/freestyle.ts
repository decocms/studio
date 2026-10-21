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

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Meter } from "@opentelemetry/api";
import {
  type CreateVmOptions,
  Freestyle,
  FreestyleApiError,
  type Vm,
} from "freestyle";
import { retry, sleep } from "@decocms/shared/std";
import pkg from "../../package.json" with { type: "json" };
import {
  ConfigRequestError,
  postConfig,
  postOrgFsConfig,
} from "../daemon-client";
import type { SandboxProvider } from "./agent-sandbox";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import { normalizeRepoUrl } from "./agent-sandbox/tenant-pools";
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
/** The base snapshot a VM's daemon took its sentinel from, when it forked a repo snapshot. */
const BASE_KEY = "studio-base-snapshot";
const USER_KEY = "studio-user-id";

/** The daemon answers within seconds of boot; this bounds a VM that never serves. */
const DAEMON_BOOT_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 500;
/** A fork's daemon is already up; this only waits for its new domain to route. */
const CLAIM_RETRY_MS = 100;
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
const IDLE_SWEEP_MS = 60_000;
const IDLE_SWEEP_PAGE = 100;
/**
 * Freestyle deletes a repo snapshot nobody forked for this long, which reclaims
 * the ones a newer default-branch head superseded.
 *
 * ponytail: a superseded snapshot lives this long after its last fork, so a repo
 * pushed N times in that window holds up to N; delete the previous one on build
 * if snapshot storage cost shows up.
 */
const REPO_SNAPSHOT_UNUSED_SECONDS = 2 * 24 * 60 * 60;
/** Clone, install and dev boot of a large storefront; past this the build is dropped. */
const REPO_SNAPSHOT_READY_TIMEOUT_MS = 30 * 60_000;
const REPO_SNAPSHOT_POLL_MS = 5_000;
const REPO_SNAPSHOT_RETRY_MS = 60 * 60_000;
/** The guest agent refuses an exec longer than 5 minutes. */
const EXEC_MAX_MS = 290_000;
const REPO_DIR = `${WORKDIR}/repo`;
const CLONE_LOG = `${WORKDIR}/tmp/app/clone`;

export interface FreestyleSandboxProviderOptions {
  /** Allow nested user namespaces inside the VM's sandbox container. Default off. */
  allowUserNamespaces?: boolean;
  apiKey: string;
  /** The sandbox image. Default: the release built from this package's version. */
  image?: string;
  /** The org-fs sidecar image. Default: the chart's `orgFs.image`. */
  orgFsSidecarImage?: string;
  /** Pause a VM after this long without network activity. Default 5 min. */
  idleTimeoutSeconds?: number;
  /**
   * Also pause a running VM once its daemon has gone this long unused. The
   * idle timeout counts any traffic, so a dev server holding an outbound
   * connection open keeps the VM awake without it. Checked every minute;
   * 0 turns it off. Default 10 min.
   */
  idlePauseMs?: number;
  /**
   * Delete a VM after this long without running. Default 1 day. A plan
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
  private readonly apiKey: string;
  private readonly freestyle: Freestyle;
  private readonly lookupClient: Freestyle;
  private readonly image: string;
  private readonly sidecarImage: string;
  private readonly allowUserNamespaces: boolean;
  private readonly idleTimeoutSeconds: number;
  private readonly idlePauseMs: number;
  private readonly autoDeleteSeconds: number;

  private readonly domainSuffix: string;
  private readonly timeDaemonRequest: ReturnType<typeof daemonProxyTimer>;
  private readonly inflight = new Inflight<string, Sandbox>();
  private readonly snapshotInflight = new Inflight<string, string>();
  /** Snapshots are immutable once built, so one positive lookup is enough. */
  private readonly knownSnapshots = new Set<string>();
  private readonly lookups = new Map<
    string,
    { found: Found | null; at: number }
  >();
  private readonly releaseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly idleSweep: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  /** Org + repo → the newest repo snapshot known to exist, and the head it was built for. */
  private readonly repoSnapshots = new Map<
    string,
    { slug: string; head: string }
  >();
  /** Org + repo with a build running, so a push mid-build waits for it. */
  private readonly repoSnapshotBuilds = new Set<string>();
  /** When a repo's last build failed; a build takes up to 30 min, so not on every ensure. */
  private readonly repoSnapshotFailures = new Map<string, number>();

  constructor(opts: FreestyleSandboxProviderOptions) {
    this.apiKey = opts.apiKey;
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
    this.allowUserNamespaces = opts.allowUserNamespaces ?? false;
    this.idleTimeoutSeconds = opts.idleTimeoutSeconds ?? 5 * 60;
    this.idlePauseMs = opts.idlePauseMs ?? 10 * 60_000;
    this.autoDeleteSeconds = opts.autoDeleteSeconds ?? 24 * 60 * 60;
    this.domainSuffix = opts.domainSuffix ?? "style.dev";
    this.timeDaemonRequest = daemonProxyTimer(opts.meter);
    if (this.idlePauseMs > 0) {
      this.idleSweep = setInterval(() => void this.pauseIdle(), IDLE_SWEEP_MS);
      this.idleSweep.unref?.();
    }
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
   * A snapshot of a VM with both containers RUNNING and the daemon healthy but
   * unclaimed, so a fork resumes a live daemon (Freestyle snapshots memory) and
   * is configured with one request instead of booted. One per image pair.
   */
  /**
   * Build this image's base snapshot now, so the first sandbox after an image
   * bump boots from it instead of waiting on the pull. Never throws.
   */
  async warm(): Promise<void> {
    await this.baseSnapshot().catch((err: unknown) =>
      console.warn(`[${LOG_LABEL}] base snapshot warm failed: ${errMsg(err)}`),
    );
  }

  private baseSnapshot(): Promise<string> {
    const { image, sidecarImage } = this;
    const namespaceMode = this.allowUserNamespaces ? "\nuser-namespaces" : "";
    const slug = `studio-sandbox-${createHash("sha256").update(`${image}\n${sidecarImage}\nrunning${namespaceMode}`).digest("hex").slice(0, 16)}`;
    if (this.knownSnapshots.has(slug)) return Promise.resolve(slug);
    return this.snapshotInflight.run(slug, async () => {
      if (await this.snapshotExists(slug)) {
        this.knownSnapshots.add(slug);
        return slug;
      }
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
        await this.startContainers(vm, this.sentinelToken(slug));
        await this.run(
          vm,
          `for i in $(seq 1 240); do curl -sf -o /dev/null http://127.0.0.1:${DAEMON_PORT}/health && exit 0; sleep 0.5; done; exit 1`,
          { timeoutMs: DAEMON_BOOT_TIMEOUT_MS + 10_000 },
        );
        await vm.snapshot({ slug });
        this.knownSnapshots.add(slug);
      } catch (err) {
        // Another replica took the slug first: theirs serves just as well.
        if (!(await this.snapshotExists(slug))) throw err;
      } finally {
        await vm.delete().catch(() => {});
      }
      return slug;
    });
  }

  /**
   * The bearer the snapshot's daemon boots with. Every fork shares it until its
   * first config rotates it, so it is derived (any replica can compute it) and
   * never stored.
   */
  private sentinelToken(slug: string): string {
    return createHmac("sha256", this.apiKey)
      .update(`daemon-sentinel:${slug}`)
      .digest("hex")
      .slice(0, 48);
  }

  private async startContainers(vm: Vm, token: string): Promise<void> {
    const env: Record<string, string> = {
      DAEMON_TOKEN: token,
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
      // Codex's read-only sandbox uses bubblewrap inside this per-user VM.
      `docker run -d --name ${CONTAINER} --restart=always${this.allowUserNamespaces ? " --security-opt seccomp=unconfined --security-opt apparmor=unconfined" : ""} -p ${DAEMON_PORT}:${DAEMON_PORT} -v ${HOST_ORG_DIR}:${WORKDIR}/org:rslave -v ${HOST_CTL_DIR}:${CTL_DIR} ${envFlags} ${shellQuote(this.image)}`,
      { env, timeoutMs: IMAGE_PULL_TIMEOUT_MS },
    );
  }

  // ---- Repo snapshots -------------------------------------------------------

  /**
   * The repo snapshot a sandbox for `opts.repo` forks, or null for the base.
   * Opt-in per ensure (`repoSnapshot`), keyed by org, repo and the head of the
   * repo's default branch. When that head has no snapshot yet, builds one in
   * the background from this ensure's own credential, and meanwhile serves the
   * previous head's: a fork checks out its own branch anyway, so a stale one
   * costs an incremental install.
   */
  private async repoSnapshotFor(
    opts: EnsureOptions,
    base: string,
  ): Promise<string | null> {
    const repo = opts.repo;
    if (!opts.repoSnapshot || !repo || !opts.tenant) return null;
    if ((opts.sandboxImage ?? "default") !== "default") return null;
    const repoUrl = normalizeRepoUrl(repo.cloneUrl)?.toLowerCase();
    if (!repoUrl) return null;
    const key = `${base}\n${opts.tenant.orgId}\n${repoUrl}`;
    const known = this.repoSnapshots.get(key);
    const head = await remoteHead(repo.cloneUrl).catch((err: unknown) => {
      console.warn(
        `[${LOG_LABEL}] default-branch head of ${repoUrl}: ${errMsg(err)}`,
      );
      return null;
    });
    if (!head || known?.head === head) return known?.slug ?? null;
    const slug = `studio-repo-${createHash("sha256").update(`${key}\n${head}`).digest("hex").slice(0, 16)}`;
    // Another replica, or this one before a restart, may have built it.
    if (await this.snapshotExists(slug).catch(() => false)) {
      this.repoSnapshots.set(key, { slug, head });
      return slug;
    }
    const failedAt = this.repoSnapshotFailures.get(key) ?? 0;
    // A harness run has no dev server to snapshot; it only forks one.
    if (
      !opts.cloneOnly &&
      !this.repoSnapshotBuilds.has(key) &&
      Date.now() - failedAt > REPO_SNAPSHOT_RETRY_MS
    ) {
      this.repoSnapshotBuilds.add(key);
      console.log(`[${LOG_LABEL}] ${repoUrl} is at ${head}; building ${slug}`);
      void this.buildRepoSnapshot(opts, repo, base, slug)
        .then(
          () => this.repoSnapshots.set(key, { slug, head }),
          (err: unknown) => {
            this.repoSnapshotFailures.set(key, Date.now());
            console.warn(
              `[${LOG_LABEL}] repo snapshot ${slug} for ${repoUrl} failed: ${errMsg(err)}`,
            );
          },
        )
        .finally(() => this.repoSnapshotBuilds.delete(key));
    }
    return known?.slug ?? null;
  }

  /**
   * Fork the base, configure its daemon the way a Kubernetes pool pod is (on
   * the sentinel, no user), wait until the dev server serves, then snapshot.
   * The fork's daemon keeps the base's sentinel, so a sandbox forked from this
   * one claims it exactly as it would a base fork.
   *
   * ⚠️ SECURITY: the snapshot outlives the credentials it was built with, so
   * they are taken off `origin` and out of the daemon's config first, and the
   * build fails closed if one is still anywhere on disk. Memory is snapshotted
   * too, so freed heap may still hold them; only the same org's sandboxes for
   * the same repo fork it, and each of those is handed the same credentials.
   */
  private buildRepoSnapshot(
    opts: EnsureOptions,
    repo: NonNullable<EnsureOptions["repo"]>,
    base: string,
    slug: string,
  ): Promise<string> {
    return this.snapshotInflight.run(slug, async () => {
      if (await this.snapshotExists(slug)) return slug;
      const { cloneUrl } = repo;
      const submodules = repo.submoduleCredentials ?? [];
      console.log(`[${LOG_LABEL}] building repo snapshot ${slug}`);
      // The default branch, no user and no extra repos: the daemon stays
      // unclaimed, like a Kubernetes pool pod, and each fork checks out its own.
      const payload = (url: string, credentials: typeof submodules) =>
        this.configPayload({
          workload: opts.workload,
          repo: {
            cloneUrl: url,
            userName: "",
            userEmail: "",
            submoduleCredentials: credentials,
          },
        }) ?? {};
      const sentinel = this.sentinelToken(base);
      const { vm } = await this.freestyle.vms.create({
        snapshotId: base,
        ttlSeconds: (REPO_SNAPSHOT_READY_TIMEOUT_MS + 10 * 60_000) / 1000,
        firewall: {
          rules: [
            { action: "allow", source: {}, destination: { public: true } },
          ],
        },
      });
      try {
        await this.postConfigInVm(vm, sentinel, payload(cloneUrl, submodules));
        await this.waitUntilServing(vm);
        // Install can rewrite tracked files (a lockfile); a fork's branch
        // checkout refuses a dirty tree, and nobody's work is in this one.
        await this.run(
          vm,
          `docker exec ${CONTAINER} git -c safe.directory='*' -C ${REPO_DIR} reset -q --hard HEAD`,
        );
        const bare = withoutCredentials(cloneUrl);
        // An empty list clears them; an absent one would keep them.
        await this.postConfigInVm(vm, sentinel, payload(bare, []));
        await this.run(
          vm,
          `docker exec ${CONTAINER} git -c safe.directory='*' -C ${REPO_DIR} remote set-url origin "$ORIGIN_URL"`,
          { env: { ORIGIN_URL: bare } },
        );
        // The daemon's clone log records the credentialed URL.
        await this.run(vm, `docker exec -u 0 ${CONTAINER} rm -f ${CLONE_LOG}`);
        const secrets = [
          credentialOf(cloneUrl),
          ...submodules.map((s) => s.token),
        ].filter(Boolean);
        if (secrets.length > 0) {
          // Install can write a credentialed git URL anywhere a package
          // manager caches. grep exits 1 for "not found"; a hit (0), an error
          // (2) or a scan that cannot finish fails the build.
          const scan = await this.run(
            vm,
            `docker exec -u 0 -e SECRETS ${CONTAINER} sh -c 'printf "%s\\n" "$SECRETS" > /tmp/.s && grep -rqsF -f /tmp/.s --exclude-dir=objects ${WORKDIR} /home /tmp --exclude=.s; echo "scan=$?"; rm -f /tmp/.s'`,
            { env: { SECRETS: secrets.join("\n") }, timeoutMs: EXEC_MAX_MS },
          );
          if (!scan.includes("scan=1")) {
            throw new Error(
              scan.includes("scan=0")
                ? "a credential survived on disk; not snapshotting"
                : `credential scan did not finish (${scan.trim().slice(-80)}); not snapshotting`,
            );
          }
        }
        await vm.snapshot({
          slug,
          autoDeleteSeconds: REPO_SNAPSHOT_UNUSED_SECONDS,
        });
      } catch (err) {
        if (!(await this.snapshotExists(slug))) throw err;
      } finally {
        await vm.delete().catch(() => {});
      }
      return slug;
    });
  }

  /** The body travels in the exec's env, so neither it nor the bearer lands in a shell line. */
  private async postConfigInVm(
    vm: Vm,
    token: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.run(
      vm,
      `curl -sf -o /dev/null -X POST -H "Authorization: Bearer $DAEMON_AUTH" -H 'Content-Type: application/json' --data "$DAEMON_BODY" http://127.0.0.1:${DAEMON_PORT}/_sandbox/config`,
      {
        env: { DAEMON_AUTH: token, DAEMON_BODY: JSON.stringify(payload) },
        timeoutMs: 60_000,
      },
    );
  }

  /** `ready` is the daemon's own verdict that the dev server serves. */
  private async waitUntilServing(vm: Vm): Promise<void> {
    const deadline = Date.now() + REPO_SNAPSHOT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const health = await this.run(
        vm,
        `curl -sf http://127.0.0.1:${DAEMON_PORT}/health`,
      ).catch(() => "");
      if (/"ready":\s*true/.test(health)) return;
      await sleep(REPO_SNAPSHOT_POLL_MS);
    }
    throw new Error(
      `dev server not serving after ${REPO_SNAPSHOT_READY_TIMEOUT_MS / 60_000} min`,
    );
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
      let warmPoolAdopted = false;
      if (existing) {
        await this.resume(existing, opts);
      } else {
        warmPoolAdopted = await this.create(handle, opts);
      }
      return {
        handle,
        workdir: WORKDIR,
        previewUrl: this.daemonUrl(handle),
        warmPoolAdopted,
        provider: "freestyle",
      };
    });
  }

  private async resume(found: Found, opts: EnsureOptions): Promise<void> {
    const { state, sourceSnapshotSlugAtCreate, metadata } =
      await found.vm.data();
    if (state !== "running") await found.vm.start();
    await this.waitForDaemon(found.daemon.url);
    // A repo snapshot's daemon still holds its base's sentinel.
    const sentinelSlug = metadata[BASE_KEY] ?? sourceSnapshotSlugAtCreate;
    if (sentinelSlug) {
      await this.reclaim(found, sentinelSlug, opts);
    }
    // A rebooted VM lost its mounts with the tmpfs ctl dir. A mounted sidecar
    // ignores the rewrite, and the daemon takes the fresh token either way.
    if (opts.orgFsConfigJson) {
      await this.relayOrgFsConfig(
        found.daemon.url,
        found.daemon.token,
        opts.orgFsConfigJson,
      );
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

  /**
   * The bearer this VM was claimed with lives in daemon memory. A cold boot
   * (Freestyle restarts a guest it finds wedged) brings the daemon back on the
   * snapshot's sentinel with no config, so every call signed with the VM's own
   * token gets 401. Offer the claim again: a daemon that still holds its token
   * refuses the sentinel. One whose writes hang, while /health still answers, is
   * the wedged guest itself, so reboot it and claim the fresh daemon.
   */
  private async reclaim(
    found: Found,
    snapshotSlug: string,
    opts: EnsureOptions,
  ): Promise<void> {
    const { url, token } = found.daemon;
    const sentinel = this.sentinelToken(snapshotSlug);
    const payload = this.configPayload(opts) ?? {};
    try {
      // A 502 here is the edge not routing yet, same as the org-fs relay, not a refusal.
      await retry(
        () => postConfig(url, sentinel, payload, { rotateToken: token }),
        {
          maxAttempts: 8,
          minTimeout: 250,
          maxTimeout: 4_000,
          isRetriable: (err) =>
            err instanceof ConfigRequestError && err.status === 502,
        },
      );
      console.log(`[${LOG_LABEL}] reclaimed ${url} after a reboot`);
      return;
    } catch (err) {
      if (err instanceof ConfigRequestError) {
        if (err.status === 401) return;
        throw err;
      }
    }
    console.warn(
      `[${LOG_LABEL}] ${url} answers /health but not writes; rebooting`,
    );
    await found.vm
      .exec({ command: "reboot -f", timeoutMs: 10_000 })
      .catch(() => {});
    await this.claimDaemon(url, sentinel, token, payload);
  }

  /** True when it forked a repo snapshot: cloned, installed and serving. */
  private async create(handle: string, opts: EnsureOptions): Promise<boolean> {
    if (opts.env && Object.keys(opts.env).length > 0) {
      // The container runs inside the snapshot, before any sandbox exists.
      throw new Error(
        `${LOG_LABEL}: per-sandbox container env is not supported`,
      );
    }
    const ms: Record<string, number> = {};
    let last = Date.now();
    const step = (name: string) => {
      ms[name] = Date.now() - last;
      last = Date.now();
    };
    const base = await this.baseSnapshot();
    const repoSnapshot = await this.repoSnapshotFor(opts, base);
    step("snapshot");
    const token = randomBytes(24).toString("hex");
    const { vm } = await this.createVm({
      snapshotId: repoSnapshot ?? base,
      slug: handle,
      idleTimeoutSeconds: this.idleTimeoutSeconds,
      metadata: {
        [TOKEN_KEY]: token,
        ...(repoSnapshot ? { [BASE_KEY]: base } : {}),
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
    step("vm-fork");
    const daemon = { url: this.daemonUrl(handle), token };
    try {
      await this.claimDaemon(
        daemon.url,
        this.sentinelToken(base),
        token,
        this.configPayload(opts) ?? {},
      );
      step("claim");
      if (opts.orgFsConfigJson) {
        await this.relayOrgFsConfig(daemon.url, token, opts.orgFsConfigJson);
      }
      step("orgfs-config");
      console.log(
        `[${LOG_LABEL}] create ${handle} from=${repoSnapshot ?? base} ms=${JSON.stringify(ms)}`,
      );
    } catch (err) {
      await vm.delete().catch(() => {});
      this.lookups.delete(handle);
      throw err;
    }
    this.remember(handle, { vm, daemon });
    return repoSnapshot !== null;
  }

  /**
   * Best-effort: a sandbox without org-fs still runs. Freestyle's edge can
   * answer 502 for a moment after a VM starts, even after the daemon took
   * its claim, and a missed relay leaves the turn without `/app/org`.
   */
  private async relayOrgFsConfig(
    url: string,
    token: string,
    configJson: string,
  ): Promise<void> {
    await retry(() => postOrgFsConfig(url, token, configJson), {
      maxAttempts: 8,
      minTimeout: 250,
      maxTimeout: 4_000,
      isRetriable: (err) =>
        err instanceof ConfigRequestError && err.status === 502,
    }).catch((err) => console.warn(`[${LOG_LABEL}] org-fs relay failed`, err));
  }

  /**
   * The fork's first config: swap the snapshot's sentinel bearer for this
   * sandbox's own, retried until the new domain routes. A 401 means an earlier
   * attempt already rotated (its response was lost), so finish with the new one.
   */
  private async claimDaemon(
    url: string,
    sentinel: string,
    token: string,
    payload: Parameters<typeof postConfig>[2],
  ): Promise<void> {
    const deadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS;
    for (;;) {
      try {
        await postConfig(url, sentinel, payload, { rotateToken: token });
        return;
      } catch (err) {
        if (err instanceof ConfigRequestError && err.status === 401) {
          await postConfig(url, token, payload);
          return;
        }
        // The daemon's own verdicts; anything else is the edge not routing yet.
        if (
          err instanceof ConfigRequestError &&
          (err.status === 400 || err.status === 409)
        ) {
          throw err;
        }
        if (Date.now() > deadline) throw err;
        await sleep(CLAIM_RETRY_MS);
      }
    }
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
      void this.pauseIfIdle(handle, graceMs).catch((err) =>
        console.warn(`[${LOG_LABEL}] pause ${handle} failed: ${errMsg(err)}`),
      );
    }, graceMs);
    timer.unref?.();
    this.releaseTimers.set(handle, timer);
  }

  /**
   * `renewTtl` cancels only this process's timer, so a turn that started
   * through another replica still has to be seen: the daemon's clock counts
   * its requests and streaming runs. A daemon that won't say is left to the
   * VM's idle timeout.
   */
  private async pauseIfIdle(handle: string, graceMs: number): Promise<void> {
    const found = await this.find(handle);
    if (!found) return;
    const idleMs = await daemonIdleMs(found.daemon.url);
    if (idleMs === null || idleMs < graceMs) return;
    await found.vm.pause();
  }

  /** The VM's idle timeout already counts every request as activity. */
  async renewTtl(handle: string): Promise<void> {
    this.cancelRelease(handle);
  }

  /**
   * Pause every running VM of ours whose daemon reports `idlePauseMs` without
   * use. The daemon's clock counts requests and streaming runs, not the dev
   * server's own traffic. Returns the handles paused; never throws.
   */
  async pauseIdle(): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const paused: (string | null)[] = [];
      // One page's idle checks in flight at a time; offset accounts for VMs this sweep already paused out of the "running" filter.
      for (let offset = 0; ; ) {
        const { vms } = await this.freestyle.vms.list({
          state: "running",
          limit: IDLE_SWEEP_PAGE,
          offset,
        });
        const results = await Promise.all(
          vms.map((data) => this.pauseIfOverIdle(data)),
        );
        paused.push(...results);
        if (vms.length < IDLE_SWEEP_PAGE) break;
        offset += vms.length - results.filter((h) => h !== null).length;
      }
      return paused.filter((h) => h !== null);
    } catch (err) {
      console.warn(`[${LOG_LABEL}] idle sweep failed: ${errMsg(err)}`);
      return [];
    } finally {
      this.sweeping = false;
    }
  }

  private async pauseIfOverIdle(
    data: Awaited<ReturnType<Freestyle["vms"]["list"]>>["vms"][number],
  ): Promise<string | null> {
    const handle = data.slug;
    if (!handle || !data.metadata[TOKEN_KEY]) return null;
    // A fork's daemon keeps the snapshot's clock until its first config.
    if (Date.now() - Date.parse(data.createdAt) < this.idlePauseMs) {
      return null;
    }
    const idleMs = await daemonIdleMs(this.daemonUrl(handle));
    if (idleMs === null || idleMs < this.idlePauseMs) return null;
    try {
      await this.freestyle.vms.ref(data.id).pause();
    } catch (err) {
      console.warn(`[${LOG_LABEL}] pause ${handle} failed: ${errMsg(err)}`);
      return null;
    }
    this.cancelRelease(handle);
    console.log(
      `[${LOG_LABEL}] paused ${handle}, daemon idle ${Math.round(idleMs / 60_000)}m`,
    );
    return handle;
  }

  private cancelRelease(handle: string): void {
    const timer = this.releaseTimers.get(handle);
    if (timer) clearTimeout(timer);
    this.releaseTimers.delete(handle);
  }

  close(): void {
    if (this.idleSweep) clearInterval(this.idleSweep);
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

/** The daemon's `/idle` doesn't count as use; null when it won't say. */
async function daemonIdleMs(url: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}/_sandbox/idle`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body: unknown = await res.json();
    return typeof body === "object" &&
      body !== null &&
      "idleMs" in body &&
      typeof body.idleMs === "number"
      ? body.idleMs
      : null;
  } catch {
    return null;
  }
}

/** `url` without userinfo, in the same shape, so the daemon sees the same repo. */
function withoutCredentials(url: string): string {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/**
 * The head of the repo's default branch, read from the smart-HTTP ref
 * advertisement the way `git ls-remote` does, so no git binary is needed. HEAD
 * is advertised first, so the read stops at the first chunk that holds it.
 */
async function remoteHead(cloneUrl: string): Promise<string | null> {
  const url = new URL(cloneUrl);
  const headers: Record<string, string> = {};
  if (url.username || url.password) {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password);
    headers.Authorization = `Basic ${btoa(`${user}:${pass}`)}`;
  }
  const res = await fetch(
    `${withoutCredentials(cloneUrl).replace(/\/$/, "")}/info/refs?service=git-upload-pack`,
    { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
  );
  if (!res.ok || !res.body) throw new Error(`info/refs ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const head = /([0-9a-f]{40}) HEAD\0/.exec(text)?.[1];
      if (head) return head;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return null;
}

function credentialOf(url: string): string {
  const { username, password } = new URL(url);
  return decodeURIComponent(password || username);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

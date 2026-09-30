/**
 * One `SandboxProvider` over the configured providers. A new sandbox goes
 * where `EnsureOptions.provider` asks, when that provider is configured and
 * can run it; else `freestyleShare` of new sandboxes go to Freestyle, and the
 * rest to Kubernetes while it has room. An existing one stays where it is.
 * When the chosen provider's ensure fails, the other one gets a try.
 * Handle-only calls go to the provider that owns the handle, because a handle
 * carries no provider tag.
 */

import { createHash } from "node:crypto";
import { retry } from "@decocms/shared/std";
import { ConfigRequestError } from "../daemon-client";
import type { AgentSandboxProvider, SandboxProvider } from "./agent-sandbox";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import { claimTenantKey } from "./agent-sandbox/tenant-pools";
import { computeHandle } from "./shared";
import { tagSandboxProvider } from "./shared/provider-tag";
import type {
  EnsureOptions,
  PodTermination,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
  SandboxPlacementReason,
  SandboxProviderKind,
} from "./types";

/** What a host serving `sandbox-api` needs beyond `SandboxProvider`. */
type HostMethods = Pick<
  AgentSandboxProvider,
  "daemonEndpoint" | "listSandboxes" | "listTenantPools"
>;

/** A provider that can answer whether a handle is its own without a claim. */
export type OwningSandboxProvider = SandboxProvider &
  Partial<Pick<HostMethods, "daemonEndpoint">> & {
    owns(handle: string): Promise<boolean>;
  };

export interface SandboxProviders {
  kubernetes?: SandboxProvider & Partial<HostMethods>;
  freestyle?: OwningSandboxProvider;
}

export interface SandboxProviderRouterOptions {
  /**
   * Share of new sandboxes, 0 to 1, placed on Freestyle when the caller names
   * no provider. Decided by the handle, so a retry lands where the first try
   * did. Default 0.
   */
  freestyleShare?: number;
}

/** Where `handle` falls in [0, 1), the same on every replica. */
export function handleShare(handle: string): number {
  const hex = createHash("sha256").update(handle).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 2 ** 32;
}

/** In-process record of the provider each recent ensure picked. */
const PICKED_MAX = 5_000;

interface Placement {
  kind: SandboxProviderKind;
  /** Absent when only one provider could take it. */
  reason?: SandboxPlacementReason;
}

const other = (kind: SandboxProviderKind): SandboxProviderKind =>
  kind === "kubernetes" ? "freestyle" : "kubernetes";

/** Errors the other provider would repeat, or that already have a retry path (the 401 re-auth). */
function repeatsElsewhere(err: unknown): boolean {
  return err instanceof ConfigRequestError;
}

export class SandboxProviderRouter implements SandboxProvider {
  private readonly picked = new Map<string, SandboxProviderKind>();

  /**
   * Handles whose sandbox on this provider outlived a fallback because its
   * delete failed. Retried when `place` next sees the handle.
   *
   * ponytail: in-process, lost on restart; Freestyle's autoDeleteSeconds
   * reclaims a stray paused VM anyway, only later.
   */
  private readonly strays = new Map<string, SandboxProviderKind>();

  private readonly freestyleShare: number;

  constructor(
    readonly providers: SandboxProviders,
    opts: SandboxProviderRouterOptions = {},
  ) {
    if (!providers.kubernetes && !providers.freestyle) {
      throw new Error("SandboxProviderRouter needs at least one provider");
    }
    this.freestyleShare = Math.min(1, Math.max(0, opts.freestyleShare ?? 0));
  }

  private get(kind: SandboxProviderKind): SandboxProvider {
    const provider = this.providers[kind];
    if (!provider)
      throw new Error(`sandbox provider ${kind} is not configured`);
    return provider;
  }

  private remember(handle: string, kind: SandboxProviderKind): void {
    this.picked.delete(handle);
    if (this.picked.size >= PICKED_MAX) {
      const oldest = this.picked.keys().next();
      if (!oldest.done) this.picked.delete(oldest.value);
    }
    this.picked.set(handle, kind);
  }

  /** Who serves an existing handle. Kubernetes is the fallback: it has no cheap ownership check. */
  async providerOf(handle: string): Promise<SandboxProviderKind> {
    const { kubernetes, freestyle } = this.providers;
    if (!freestyle) return "kubernetes";
    if (!kubernetes) return "freestyle";
    const picked = this.picked.get(handle);
    if (picked) return picked;
    // During a Freestyle outage a Freestyle handle gets Kubernetes' 404, which
    // it would get anyway; a Kubernetes handle keeps working.
    const owned = await freestyle.owns(handle).catch(() => false);
    return owned ? "freestyle" : "kubernetes";
  }

  private async owner(handle: string): Promise<SandboxProvider> {
    return this.get(await this.providerOf(handle));
  }

  /** Where `ensure` puts this sandbox, and why. */
  async place(handle: string, opts: EnsureOptions): Promise<Placement> {
    const { kubernetes, freestyle } = this.providers;
    // Only the default image is built for Freestyle; Android always runs on Kubernetes.
    const image = opts.sandboxImage ?? "default";
    if (image !== "default") {
      if (!kubernetes) {
        throw new Error(`sandbox image ${image} needs the kubernetes provider`);
      }
      return { kind: "kubernetes", reason: freestyle ? "image" : undefined };
    }
    if (!kubernetes) return { kind: "freestyle" };
    if (!freestyle) return { kind: "kubernetes" };
    // A copy a fallback left behind is not the sandbox, whatever it answers.
    const stray = this.strays.get(handle);
    if (stray) this.retire(stray, handle);
    // Kubernetes first, so a Freestyle outage never touches its sandboxes.
    if (
      stray !== "kubernetes" &&
      (await kubernetes.alive(handle).catch(() => false))
    ) {
      return { kind: "kubernetes", reason: "existing" };
    }
    const owned =
      stray === "freestyle"
        ? false
        : await freestyle.owns(handle).catch(() => null);
    if (owned) return { kind: "freestyle", reason: "existing" };
    if (owned === null) {
      return { kind: "kubernetes", reason: "freestyle-unavailable" };
    }
    if (opts.provider) return { kind: opts.provider, reason: "requested" };
    if (this.hasWarmPool(opts, image)) {
      return { kind: "kubernetes", reason: "warm-pool" };
    }
    if (handleShare(handle) < this.freestyleShare) {
      return { kind: "freestyle", reason: "split" };
    }
    const roomy = await kubernetes.hasSchedulableCapacity().catch(() => false);
    return roomy
      ? { kind: "kubernetes", reason: "split" }
      : { kind: "freestyle", reason: "capacity" };
  }

  /** The org has pods already cloned and running for this image. */
  private hasWarmPool(opts: EnsureOptions, image: string): boolean {
    const tenant = claimTenantKey(opts);
    if (!tenant) return false;
    const pools = this.providers.kubernetes?.listTenantPools?.() ?? [];
    return pools.some((p) => p.tenant === tenant && p.image === image);
  }

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    const { provider: _requested, ...rest } = opts;
    const handle = computeHandle(id);
    const placed = await this.place(handle, opts);
    this.remember(handle, placed.kind);
    // A new sandbox on the stray's provider replaces it; stop deleting it.
    if (this.strays.get(handle) === placed.kind) this.strays.delete(handle);
    let failure: unknown;
    try {
      const sandbox = await this.get(placed.kind).ensure(id, rest);
      return placed.reason
        ? { ...sandbox, placement: { reason: placed.reason } }
        : sandbox;
    } catch (err) {
      failure = tagSandboxProvider(err, placed.kind);
    }
    const fallback = other(placed.kind);
    if (
      !placed.reason ||
      placed.reason === "image" ||
      repeatsElsewhere(failure)
    ) {
      throw failure;
    }
    console.warn(
      `[SandboxProviderRouter] ensure ${handle} failed on ${placed.kind}, trying ${fallback}:`,
      failure instanceof Error ? failure.message : String(failure),
    );
    this.remember(handle, fallback);
    let sandbox: Sandbox;
    try {
      sandbox = await this.get(fallback).ensure(id, rest);
    } catch (err) {
      this.picked.delete(handle);
      throw tagSandboxProvider(err, fallback);
    }
    // A resumed sandbox moved: its work was published to git on the way out
    // and the new one cloned the same branch. One owner per handle.
    if (placed.reason === "existing") this.retire(placed.kind, handle);
    return {
      ...sandbox,
      placement: { reason: "fallback", fallbackFrom: placed.kind },
    };
  }

  /** Delete the sandbox a fallback left behind on `kind`, in the background. */
  private retire(kind: SandboxProviderKind, handle: string): void {
    this.strays.set(handle, kind);
    void retry(
      async () => {
        if (this.strays.get(handle) === kind)
          await this.get(kind).delete(handle);
      },
      { maxAttempts: 3 },
    )
      .then(() => {
        if (this.strays.get(handle) === kind) this.strays.delete(handle);
      })
      .catch((err: unknown) =>
        console.warn(
          `[SandboxProviderRouter] delete of ${kind} sandbox ${handle} after fallback failed:`,
          err instanceof Error ? err.message : String(err),
        ),
      );
  }

  async delete(handle: string): Promise<void> {
    const stray = this.strays.get(handle);
    this.strays.delete(handle);
    await Promise.all([
      (await this.owner(handle)).delete(handle),
      stray &&
        this.get(stray)
          .delete(handle)
          .catch(() => {}),
    ]);
    this.picked.delete(handle);
  }

  async lastTermination(handle: string): Promise<PodTermination | null> {
    return (await this.owner(handle)).lastTermination(handle);
  }

  async alive(handle: string): Promise<boolean> {
    return (await this.owner(handle)).alive(handle);
  }

  async *watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    yield* (await this.owner(handle)).watchClaimLifecycle(handle, signal);
  }

  /** Room anywhere: an ensure without room on Kubernetes lands on Freestyle. */
  async hasSchedulableCapacity(): Promise<boolean> {
    const { kubernetes, freestyle } = this.providers;
    if (!kubernetes || freestyle) return true;
    return kubernetes.hasSchedulableCapacity();
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    return (await this.owner(handle)).getPreviewUrl(handle);
  }

  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    return (await this.owner(handle)).proxyDaemonRequest(handle, path, init);
  }

  async adoptLiveClaim(id: SandboxId, handle: string): Promise<boolean> {
    return (await this.owner(handle)).adoptLiveClaim(id, handle);
  }

  async resolvePreviewUpstreamUrl(handle: string): Promise<string | null> {
    return (await this.owner(handle)).resolvePreviewUpstreamUrl(handle);
  }

  async proxyPreviewRequest(
    handle: string,
    request: Request,
  ): Promise<Response> {
    return (await this.owner(handle)).proxyPreviewRequest(handle, request);
  }

  async markTenantPoolsDirty(repoUrl: string, ref: string): Promise<string[]> {
    return (
      (await this.providers.kubernetes?.markTenantPoolsDirty(repoUrl, ref)) ??
      []
    );
  }

  async releaseAfter(handle: string, graceMs: number): Promise<void> {
    await (await this.owner(handle)).releaseAfter(handle, graceMs);
  }

  async renewTtl(handle: string): Promise<void> {
    await (await this.owner(handle)).renewTtl(handle);
  }

  async daemonEndpoint(
    handle: string,
  ): Promise<{ url: string; token: string } | null> {
    const owner = this.providers[await this.providerOf(handle)];
    if (!owner?.daemonEndpoint) {
      throw new Error("sandbox provider has no daemon endpoint to serve");
    }
    return owner.daemonEndpoint(handle);
  }

  /** Only Kubernetes sandboxes take pushed credentials. */
  listSandboxes(): ReturnType<HostMethods["listSandboxes"]> {
    return this.providers.kubernetes?.listSandboxes?.() ?? [];
  }

  listTenantPools(): ReturnType<HostMethods["listTenantPools"]> {
    return this.providers.kubernetes?.listTenantPools?.() ?? [];
  }

  close(): void {
    this.providers.kubernetes?.close();
    this.providers.freestyle?.close();
    this.picked.clear();
    this.strays.clear();
  }
}

/**
 * One `SandboxProvider` over the configured providers. A new sandbox goes
 * where `EnsureOptions.provider` asks, when that provider is configured and
 * can run it; else `freestyleShare` of new sandboxes go to Freestyle, and the
 * rest to Kubernetes while it has room. An existing one stays where it is.
 * Handle-only calls go to the provider that owns the handle, because a handle
 * carries no provider tag.
 */

import { createHash } from "node:crypto";
import type { AgentSandboxProvider, SandboxProvider } from "./agent-sandbox";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import { computeHandle } from "./shared";
import { tagSandboxProvider } from "./shared/provider-tag";
import type {
  EnsureOptions,
  PodTermination,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
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

export class SandboxProviderRouter implements SandboxProvider {
  private readonly picked = new Map<string, SandboxProviderKind>();

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
    return (await freestyle.owns(handle)) ? "freestyle" : "kubernetes";
  }

  private async owner(handle: string): Promise<SandboxProvider> {
    return this.get(await this.providerOf(handle));
  }

  /** Where `ensure` puts this sandbox. */
  async place(
    handle: string,
    opts: EnsureOptions,
  ): Promise<SandboxProviderKind> {
    const { kubernetes, freestyle } = this.providers;
    // Only the default image is built for Freestyle; Android always runs on Kubernetes.
    const image = opts.sandboxImage ?? "default";
    if (image !== "default") {
      if (!kubernetes) {
        throw new Error(`sandbox image ${image} needs the kubernetes provider`);
      }
      return "kubernetes";
    }
    if (!kubernetes) return "freestyle";
    if (!freestyle) return "kubernetes";
    if (await freestyle.owns(handle)) return "freestyle";
    if (await kubernetes.alive(handle).catch(() => false)) return "kubernetes";
    if (opts.provider) return opts.provider;
    if (handleShare(handle) < this.freestyleShare) return "freestyle";
    const roomy = await kubernetes.hasSchedulableCapacity().catch(() => false);
    return roomy ? "kubernetes" : "freestyle";
  }

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    const { provider: _requested, ...rest } = opts;
    const handle = computeHandle(id);
    const kind = await this.place(handle, opts);
    this.remember(handle, kind);
    try {
      return await this.get(kind).ensure(id, rest);
    } catch (err) {
      throw tagSandboxProvider(err, kind);
    }
  }

  async delete(handle: string): Promise<void> {
    await (await this.owner(handle)).delete(handle);
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
  }
}

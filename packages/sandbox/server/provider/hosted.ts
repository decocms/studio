import type { SandboxImage } from "@decocms/shared/git-providers";
import type { ClaimPhase } from "./lifecycle-types";
import type {
  EnsureOptions,
  PodTermination,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
} from "./types";

/**
 * What Studio calls on a hosted sandbox provider. `RemoteSandboxProvider` is
 * the implementation; tests substitute fakes.
 */
export interface HostedSandboxProvider {
  ensure(id: SandboxId, opts?: EnsureOptions): Promise<Sandbox>;
  delete(handle: string): Promise<void>;
  lastTermination(handle: string): Promise<PodTermination | null>;
  alive(handle: string): Promise<boolean>;
  watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown>;
  hasSchedulableCapacity(): Promise<boolean>;
  /** Image variants a repository can pick, besides `default`. */
  listSandboxImages(): Promise<SandboxImage[]>;
  getPreviewUrl(handle: string): Promise<string | null>;
  proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response>;
  adoptLiveClaim(id: SandboxId, handle: string): Promise<boolean>;
  resolvePreviewUpstreamUrl(handle: string): Promise<string | null>;
  proxyPreviewRequest(handle: string, request: Request): Promise<Response>;
  /** Pool names a push to `repoFullName`@`ref` made stale. */
  markTenantPoolsDirty(repoFullName: string, ref: string): Promise<string[]>;
  releaseAfter(handle: string, graceMs: number): Promise<void>;
  renewTtl(handle: string): Promise<void>;
  close(): void;
}

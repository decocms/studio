/**
 * Default sandbox provider kind for `(SANDBOX_START, ensureSandbox)` when the
 * caller hasn't explicitly chosen one.
 *
 * Policy:
 *   - link online for this user → "user-desktop"
 *   - otherwise → whatever the env's cluster provider is (cluster)
 *
 * The link probe is the same one `resolveDispatchTarget` uses, so manual sandbox
 * start (from the branch picker) and auto-start (from VmEventsBridge) agree.
 */
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { LinkClaimRegistry } from "@/links/link-claim-registry";

export interface ResolveDefaultDeps {
  linkClaimRegistry: LinkClaimRegistry;
  resolveEnvKind: () => SandboxProviderKind;
}

export async function resolveDefaultSandboxProviderKind(
  userId: string,
  deps: ResolveDefaultDeps,
): Promise<SandboxProviderKind> {
  const link = await deps.linkClaimRegistry.get(userId);
  if (link) return "user-desktop";
  return deps.resolveEnvKind();
}

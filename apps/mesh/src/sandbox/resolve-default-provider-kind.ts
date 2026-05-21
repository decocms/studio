/**
 * Default sandbox provider kind for `(VM_START, ensureVmForBranch)` when the
 * caller hasn't explicitly chosen one.
 *
 * Policy:
 *   - link online for this user → "remote-user"
 *   - otherwise → whatever the env's cluster runner is (docker/freestyle/agent-sandbox)
 *
 * The link probe is the same one `resolveDispatchTarget` uses, so manual VM
 * start (from the branch picker) and auto-start (from VmEventsBridge) agree.
 */
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { LinkRegistry } from "@/links/link-registry";

export interface ResolveDefaultDeps {
  linkRegistry: LinkRegistry;
  resolveEnvKind: () => SandboxProviderKind;
}

export async function resolveDefaultSandboxProviderKind(
  userId: string,
  deps: ResolveDefaultDeps,
): Promise<SandboxProviderKind> {
  const link = await deps.linkRegistry.get(userId);
  if (link) return "remote-user";
  return deps.resolveEnvKind();
}

/**
 * Normalize a sandbox provider kind into a DispatchTarget.
 *
 * No liveness check: the backend is optimistic. `user-desktop` runs attempt the
 * tunnel and surface failure as "not connected"; the frontend gates on the live
 * `/api/links/status` probe. Capability gating is the client's job too.
 */
import {
  normalizeSandboxProviderKind,
  type LegacySandboxProviderKind,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";

export type DispatchTarget =
  | { sandboxProviderKind: "agent-sandbox" }
  | { sandboxProviderKind: "user-desktop" };

export function resolveDispatchTarget(input: {
  sandboxProviderKind: SandboxProviderKind | LegacySandboxProviderKind;
}): DispatchTarget {
  const kind = normalizeSandboxProviderKind(input.sandboxProviderKind);
  return kind === "user-desktop"
    ? { sandboxProviderKind: "user-desktop" }
    : { sandboxProviderKind: "agent-sandbox" };
}

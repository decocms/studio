/**
 * Resolve where a dispatch should execute, from the harness and the sandbox
 * provider kind pinned for this (thread, virtualMcpId, branch).
 *
 * `sandboxProviderKind` is the single source of truth:
 *   - `agent-sandbox` → hosted execution
 *   - `user-desktop` → laptop execution through the user's link daemon
 *
 * Link health is checked only for `user-desktop`. Offline/missing-capability
 * paths surface a `{ ok: false, error }` result which `POST /messages`
 * translates to a 409 response.
 *
 * Takes the kind directly (not a `SandboxRecord`) so the POST handler can
 * decide where to dispatch without eagerly provisioning a sandbox — sandbox
 * provisioning is deferred to the built-in tools layer, which already
 * resolves the handle lazily on first sandbox-tool invocation.
 */
import {
  normalizeSandboxProviderKind,
  type LegacySandboxProviderKind,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";
import type { Capability } from "./protocol";
import type { LinkClaimRegistry, LinkClaim } from "./link-claim-registry";
import type { HarnessId } from "../harnesses";

export type DispatchTarget =
  | { sandboxProviderKind: "agent-sandbox" }
  | { sandboxProviderKind: "user-desktop"; link: LinkClaim };

export type DispatchError =
  | { kind: "user_desktop_link_offline" }
  | {
      kind: "user_desktop_link_capability_missing";
      activeCapabilities: Capability[];
    };

export type ResolveDispatchTargetResult =
  | { ok: true; target: DispatchTarget }
  | { ok: false; error: DispatchError };

interface Input {
  harnessId: HarnessId;
  sandboxProviderKind: SandboxProviderKind | LegacySandboxProviderKind;
  userId: string;
}

interface Deps {
  linkClaimRegistry: LinkClaimRegistry;
}

function capabilityFor(harnessId: HarnessId): Capability | null {
  if (harnessId === "claude-code") return "claude-code";
  if (harnessId === "codex") return "codex";
  if (harnessId === "decopilot") return "decopilot-sandbox";
  return null;
}

export async function resolveDispatchTarget(
  input: Input,
  deps: Deps,
): Promise<ResolveDispatchTargetResult> {
  const kind = normalizeSandboxProviderKind(input.sandboxProviderKind);

  if (kind !== "user-desktop") {
    return { ok: true, target: { sandboxProviderKind: "agent-sandbox" } };
  }

  const link = await deps.linkClaimRegistry.get(input.userId);
  if (!link) {
    return { ok: false, error: { kind: "user_desktop_link_offline" } };
  }

  const requiredCap = capabilityFor(input.harnessId);
  if (requiredCap && !link.capabilities.includes(requiredCap)) {
    return {
      ok: false,
      error: {
        kind: "user_desktop_link_capability_missing",
        activeCapabilities: link.capabilities,
      },
    };
  }

  return {
    ok: true,
    target: { sandboxProviderKind: "user-desktop", link },
  };
}

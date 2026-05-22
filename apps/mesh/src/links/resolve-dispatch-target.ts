/**
 * Resolve where a dispatch should execute, from the harness and the sandbox
 * provider kind pinned for this (thread, virtualMcpId, branch).
 *
 * `sandboxProviderKind` is the single source of truth:
 *   - cloud kind (docker/freestyle/agent-sandbox) → cluster default sandbox
 *   - `remote-user` + decopilot → cluster decopilot, sandbox tools tunneled
 *   - `remote-user` + claude-code/codex → whole stream dispatched to the desktop
 *
 * Link health is checked only for `remote-user`. Offline/missing-capability
 * paths return an `error` target which `POST /messages` surfaces as 409.
 *
 * Takes the kind directly (not a `VmMapEntry`) so the POST handler can
 * decide where to dispatch without eagerly provisioning a sandbox — VM
 * provisioning is deferred to the built-in tools layer, which already
 * resolves the handle lazily on first VM-tool invocation.
 */
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { Capability, LinkEntry } from "./protocol";
import type { LinkRegistry } from "./link-registry";
import type { HarnessId } from "../harnesses";

export type DispatchTarget =
  | {
      kind: "error";
      reason: "link_offline" | "capability_missing";
      activeCapabilities?: string[];
    }
  | { kind: "local"; sandbox: "default" | "remote-user"; link?: LinkEntry }
  | { kind: "remote-cli"; link: LinkEntry };

interface Input {
  harnessId: HarnessId;
  sandboxProviderKind: SandboxProviderKind;
  userId: string;
}

interface Deps {
  linkRegistry: LinkRegistry;
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
): Promise<DispatchTarget> {
  const kind = input.sandboxProviderKind;

  if (kind !== "remote-user") {
    return { kind: "local", sandbox: "default" };
  }

  const link = await deps.linkRegistry.get(input.userId);
  if (!link) return { kind: "error", reason: "link_offline" };

  const requiredCap = capabilityFor(input.harnessId);
  if (requiredCap && !link.capabilities.includes(requiredCap)) {
    return {
      kind: "error",
      reason: "capability_missing",
      activeCapabilities: link.capabilities,
    };
  }

  if (input.harnessId === "decopilot") {
    return { kind: "local", sandbox: "remote-user", link };
  }
  return { kind: "remote-cli", link };
}

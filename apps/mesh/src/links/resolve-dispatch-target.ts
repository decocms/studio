/**
 * Resolve where a dispatch should execute, from the harness and the VM entry
 * the user has selected for this (virtualMcpId, branch).
 *
 * The VM entry's `sandboxProviderKind` is the single source of truth:
 *   - cloud kind (docker/freestyle/agent-sandbox) → cluster default sandbox
 *   - `remote-user` + decopilot → cluster decopilot, sandbox tools tunneled
 *   - `remote-user` + claude-code/codex → whole stream dispatched to the desktop
 *
 * Link health is checked only for `remote-user` VMs. Offline/missing-capability
 * paths return an `error` target which `POST /messages` surfaces as 409.
 */
import type { VmMapEntry } from "@decocms/mesh-sdk";
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
  vm: VmMapEntry;
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
  const kind = input.vm.sandboxProviderKind;

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

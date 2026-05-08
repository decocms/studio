/**
 * Single source of truth for `projectRef`. Two opaque encodings:
 *   `agent:<orgId>:<virtualMcpId>:<branch>` — agent-thread sandboxes.
 *   `thread:<threadId>` — ad-hoc sandboxes.
 * Runners never parse the ref; they hash it for their routing key.
 */

export type AgentSandboxRefInput = {
  orgId: string;
  virtualMcpId: string;
  branch: string;
};

export type ThreadSandboxRefInput = { threadId: string };

export type SandboxRefInput = AgentSandboxRefInput | ThreadSandboxRefInput;

export function composeSandboxRef(input: SandboxRefInput): string {
  if ("threadId" in input) {
    if (!input.threadId)
      throw new Error("composeSandboxRef: threadId required");
    return `thread:${input.threadId}`;
  }
  if (!input.orgId || !input.virtualMcpId || !input.branch) {
    throw new Error(
      "composeSandboxRef: orgId, virtualMcpId and branch are all required for agent refs",
    );
  }
  return `agent:${input.orgId}:${input.virtualMcpId}:${input.branch}`;
}

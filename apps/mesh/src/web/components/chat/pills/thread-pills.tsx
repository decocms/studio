import type { VmMap } from "@decocms/mesh-sdk";
import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { BranchPill } from "./branch-pill";
import { AgentPill } from "./agent-pill";
import {
  computeAgentOptions,
  pinsForOption,
  pinsToOption,
} from "./agent-options";
import { useChatPrefs, useOptionalChatStream } from "../context";
import { track } from "@/web/lib/posthog-client";
import { useVmStart } from "@/web/components/vm/hooks/use-vm-start";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useCurrentLink } from "@/web/hooks/use-current-link";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  virtualMcpId: string;
  connectionId: string;
  owner: string;
  repo: string;
  vmMap: VmMap | undefined;
  currentBranch: string | null;
  onBranchChange: (branch: string) => void;
  threadKind: SandboxProviderKind | null;
  threadHarness: HarnessId | null;
}

export function ThreadPills({
  orgId,
  orgSlug,
  userId,
  virtualMcpId,
  connectionId,
  owner,
  repo,
  vmMap,
  currentBranch,
  onBranchChange,
  threadKind,
  threadHarness,
}: Props) {
  const stream = useOptionalChatStream();
  const isActive = (stream?.messages ?? []).length > 0;

  const { pendingAgentOption, setPendingAgentOption } = useChatPrefs();

  const keys = useAiProviderKeys();
  const link = useCurrentLink();

  const options = computeAgentOptions({
    hasAnyKey: keys.length > 0,
    link,
  });

  // Active thread → derive the option from the persisted (harness, kind)
  // row. Empty thread → use the user's pending pick (or fall through to
  // the first eligible option so the pill never goes blank when an
  // option list exists).
  const activeOption = isActive
    ? pinsToOption(threadHarness, threadKind)
    : (pendingAgentOption ?? options[0] ?? null);

  const { org } = useProjectContext();
  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const startVm = useVmStart(mcpClient);

  return (
    <div className="flex items-center gap-2 text-xs">
      <BranchPill
        orgId={orgId}
        orgSlug={orgSlug}
        userId={userId}
        virtualMcpId={virtualMcpId}
        connectionId={connectionId}
        owner={owner}
        repo={repo}
        vmMap={vmMap}
        value={currentBranch}
        onChange={onBranchChange}
        locked={isActive}
      />
      <span className="text-muted-foreground/60">·</span>
      <AgentPill
        options={options}
        current={activeOption}
        locked={isActive}
        onSelect={(opt) => {
          setPendingAgentOption(opt);

          // Eager VM start when the user chose a laptop option and we
          // already have a branch — gives instant preview feedback. For
          // plain Decopilot (cloud) the server resolves on first POST.
          if (pinsForOption(opt).sandbox === "remote-user" && currentBranch) {
            startVm.mutate({
              virtualMcpId,
              branch: currentBranch,
              sandboxProviderKind: "remote-user" as const,
            });
          }

          track("agent_pill_changed", {
            from: activeOption,
            to: opt,
            branch: currentBranch,
          });
        }}
      />
    </div>
  );
}

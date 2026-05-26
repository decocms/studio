import type { ReactNode } from "react";
import type { SandboxMap, VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
} from "@/web/lib/agent-capabilities";
import { useOptionalChatStream } from "../context";
import { BranchPill } from "./branch-pill";
import { ModePicker } from "./mode-picker";

interface PureProps {
  clonable: boolean;
  connected: boolean;
  branchPill: ReactNode;
  modePicker: ReactNode;
}

/**
 * Pure layout — used by tests. Returns null when the virtual MCP isn't
 * clonable; hides the branch pill for template-cloned agents (the
 * `connected` flag being false). Locking is owned by the child pills,
 * not the row layout.
 */
export function ChatModeRowPure({
  clonable,
  connected,
  branchPill,
  modePicker,
}: PureProps) {
  if (!clonable) return null;
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-xs">
      {connected && branchPill}
      {modePicker}
    </div>
  );
}

interface SmartProps {
  orgId: string;
  orgSlug: string;
  userId: string;
  virtualMcp: VirtualMCPEntity | null | undefined;
  sandboxMap: SandboxMap | undefined;
  currentBranch: string | null;
  onBranchChange: (branch: string) => void;
  /** Forwarded to both BranchPill and ModePicker. The row itself is a
   *  plain flex container — it doesn't render labels of its own. */
  compact?: boolean;
}

/**
 * Smart wrapper. Composes BranchPill (when the virtual MCP has an
 * attached github connection) with the ModePicker. The whole row is
 * gated on `agentHasClonableSource`. Locked state is inherited from
 * the active chat stream so both pills lock together once a thread
 * has any messages.
 */
export function ChatModeRow({
  orgId,
  orgSlug,
  userId,
  virtualMcp,
  sandboxMap,
  currentBranch,
  onBranchChange,
  compact = false,
}: SmartProps) {
  const stream = useOptionalChatStream();
  const locked = (stream?.messages ?? []).length > 0;

  const clonable = agentHasClonableSource(virtualMcp?.metadata);
  const connected = agentHasConnectedGithub(virtualMcp);
  const githubRepo = virtualMcp?.metadata?.githubRepo ?? null;

  return (
    <ChatModeRowPure
      clonable={clonable}
      connected={connected}
      branchPill={
        <BranchPill
          orgId={orgId}
          orgSlug={orgSlug}
          userId={userId}
          virtualMcpId={virtualMcp?.id ?? ""}
          connectionId={githubRepo?.connectionId ?? ""}
          owner={githubRepo?.owner ?? ""}
          repo={githubRepo?.name ?? ""}
          sandboxMap={sandboxMap}
          value={currentBranch}
          onChange={onBranchChange}
          locked={locked}
          compact={compact}
        />
      }
      modePicker={
        <ModePicker
          locked={locked}
          currentBranch={currentBranch}
          virtualMcpId={virtualMcp?.id ?? ""}
          compact={compact}
        />
      }
    />
  );
}

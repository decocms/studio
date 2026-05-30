import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useOptionalChatStream } from "../context";
import { ModePicker } from "./mode-picker";

interface PureProps {
  clonable: boolean;
  modePicker: ReactNode;
}

/**
 * Pure layout — used by tests. Returns null when the virtual MCP isn't
 * clonable. Locking is owned by the child pills, not the row layout.
 *
 * Renders as a fragment (no wrapping div) so the pills sit in the
 * parent flex flow with the same gap as their siblings.
 */
export function ChatModeRowPure({ clonable, modePicker }: PureProps) {
  if (!clonable) return null;
  return <>{modePicker}</>;
}

interface SmartProps {
  virtualMcp: VirtualMCPEntity | null | undefined;
  currentBranch: string | null;
}

/**
 * Smart wrapper. Renders the ModePicker for clonable agents. Branch
 * selection lives in the agent-shell header next to Save changes.
 */
export function ChatModeRow({ virtualMcp, currentBranch }: SmartProps) {
  const stream = useOptionalChatStream();
  const locked = (stream?.messages ?? []).length > 0;

  const clonable = agentHasClonableSource(virtualMcp?.metadata);

  return (
    <ChatModeRowPure
      clonable={clonable}
      modePicker={
        <ModePicker
          locked={locked}
          currentBranch={currentBranch}
          virtualMcpId={virtualMcp?.id ?? ""}
        />
      }
    />
  );
}

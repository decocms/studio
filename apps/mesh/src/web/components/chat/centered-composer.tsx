/**
 * CenteredComposer — empty-state composer for /$org/$taskId.
 *
 * Renders:
 *   above-row (Branch + Harness pills, unlocked, gated by capability)
 *   centered Chat.Input
 *   icebreakers (below the input)
 *
 * Mounted by ChatPanelContent when isChatEmpty is true. The pure
 * variant takes pre-rendered slot nodes so it's trivially testable
 * without mocking MeshContext, virtual-MCP queries, or auth state.
 *
 * Read-only fallback: when the active task was created by someone else
 * the above-row and icebreakers are hidden — Chat.Input then renders
 * its own "Read only" banner.
 */
import type { ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
import { Chat } from "./index";
import { useChatPrefs, useOptionalChatTask } from "./context";
import { ChatModeRow } from "./pills/chat-mode-row";

interface PureProps {
  readOnly: boolean;
  aboveRow: ReactNode;
  input: ReactNode;
  iceBreakers: ReactNode;
}

export function CenteredComposerPure({
  readOnly,
  aboveRow,
  input,
  iceBreakers,
}: PureProps) {
  return (
    <div
      data-chat-centered="true"
      className={cn(
        "h-full w-full flex flex-col items-center justify-center px-4 gap-6",
      )}
    >
      <div className="w-full max-w-3xl flex flex-col gap-3">
        {!readOnly && aboveRow ? (
          <div
            data-chat-above-row="true"
            // `@container/chat-bottom` makes BranchPicker / ModePicker expand
            // their labels via the same `@[320px]/chat-bottom:` queries they
            // use inside the docked input bottom row. Without this the pills
            // stay in their collapsed (icon-only) form here because the
            // queries find no matching container ancestor.
            className="@container/chat-bottom flex justify-center gap-2"
          >
            {aboveRow}
          </div>
        ) : null}
        {input}
        {!readOnly && iceBreakers ? (
          <div className="w-full">{iceBreakers}</div>
        ) : null}
      </div>
    </div>
  );
}

interface Props {
  onOpenContextPanel: () => void;
}

export function CenteredComposer({ onOpenContextPanel }: Props) {
  const { selectedVirtualMcp } = useChatPrefs();
  const displayAgent = selectedVirtualMcp;
  const fullVm = useVirtualMCP(displayAgent?.id ?? "");
  const taskCtx = useOptionalChatTask();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const task = taskCtx?.activeTask ?? null;
  const readOnly = Boolean(
    userId && task?.created_by && task.created_by !== userId,
  );

  return (
    <CenteredComposerPure
      readOnly={readOnly}
      aboveRow={
        <ChatModeRow
          virtualMcp={fullVm}
          currentBranch={taskCtx?.currentBranch ?? null}
        />
      }
      input={<Chat.Input onOpenContextPanel={onOpenContextPanel} />}
      iceBreakers={<Chat.IceBreakers />}
    />
  );
}

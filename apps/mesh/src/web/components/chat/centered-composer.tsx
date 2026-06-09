/**
 * CenteredComposer — empty-state composer for /$org/$taskId.
 *
 * Hybrid of the original SidebarEmptyState and the centered-input
 * design. Renders, top to bottom, all centered in Chat.Main:
 *
 *   1. agent identity block (icon + title + description)
 *   2. above-row pills (Branch + Harness, gated by capability)
 *   3. centered Chat.Input (no Branch/Harness in its bottom row)
 *   4. icebreakers
 *
 * Read-only fallback: when the active task was created by someone else
 * the identity, above-row and icebreakers are hidden — Chat.Input then
 * renders its own "Read only" banner.
 */
import type { ReactNode } from "react";
import { IntegrationIcon } from "@/web/components/integration-icon";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { Users03 } from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { Chat } from "./index";
import { useChatPrefs, useOptionalChatTask } from "./context";
import { ChatModeRow } from "./pills/chat-mode-row";

interface PureProps {
  readOnly: boolean;
  identity: ReactNode;
  aboveRow: ReactNode;
  input: ReactNode;
  iceBreakers: ReactNode;
}

export function CenteredComposerPure({
  readOnly,
  identity,
  aboveRow,
  input,
  iceBreakers,
}: PureProps) {
  return (
    <div
      data-chat-centered="true"
      className="h-full w-full flex flex-col items-center justify-center px-4 gap-6"
    >
      <div className="w-full max-w-3xl flex flex-col gap-6">
        {!readOnly && identity ? identity : null}
        {/* above-row + input live in a tighter sub-stack (gap-2) so the
            pills sit close to the input they configure. identity and
            icebreakers stay at the outer gap-6 from this block. */}
        <div className="flex flex-col gap-2">
          {!readOnly && aboveRow ? (
            <div
              data-chat-above-row="true"
              // `@container/chat-bottom` so BranchPicker / ModePicker
              // resolve their `@[320px]/chat-bottom:` queries here too
              // and render with full labels — same affordance as inside
              // the docked input.
              className="@container/chat-bottom flex justify-start gap-1"
            >
              {aboveRow}
            </div>
          ) : null}
          {input}
        </div>
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
  const { org } = useProjectContext();
  const { selectedVirtualMcp } = useChatPrefs();
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;
  const fullVm = useVirtualMCP(displayAgent.id);
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
      identity={
        <div className="flex flex-col items-center justify-center gap-2 md:gap-4 text-center">
          <IntegrationIcon
            icon={displayAgent.icon}
            name={displayAgent.title}
            size="lg"
            fallbackIcon={<Users03 size={32} />}
            className="size-10 min-w-10 md:size-[60px]! md:min-w-[60px] rounded-xl md:rounded-[18px]!"
          />
          <h3 className="text-base md:text-xl font-medium text-foreground">
            {displayAgent.title}
          </h3>
          <div className="text-muted-foreground text-center text-base max-w-md line-clamp-2">
            {displayAgent.description ??
              "Ask anything about configuring model providers or using MCP Mesh."}
          </div>
        </div>
      }
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

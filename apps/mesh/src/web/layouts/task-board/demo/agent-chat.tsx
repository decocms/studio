import { ToolCallShell } from "@/web/components/chat/message/parts/tool-call-part/common.tsx";
import { ChatInput } from "@/web/components/chat/input";
import { cn } from "@deco/ui/lib/utils.ts";
import { Edit02, File06, SearchMd, TerminalSquare, X } from "@untitledui/icons";
import type React from "react";
import type { DemoChatMessage, DemoChatToolIcon, DemoSession } from "./data";
import { DecoAvatar } from "./icons";
import { clearActiveChatSession } from "./store";

const TOOL_ICONS: Record<
  DemoChatToolIcon,
  React.ComponentType<{ className?: string }>
> = {
  read: File06,
  edit: Edit02,
  bash: TerminalSquare,
  search: SearchMd,
};

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end px-4">
      <div className="max-w-[80%] rounded-lg border border-border/60 bg-muted/75 px-4 py-2 text-[14px] text-foreground">
        {text}
      </div>
    </div>
  );
}

function AssistantTurn({ message }: { message: DemoChatMessage }) {
  return (
    <div className="flex flex-col gap-0.5 px-4">
      <div className="mb-1 flex items-center gap-1.5">
        <DecoAvatar className="size-4" />
        <span className="text-[13px] font-medium text-foreground">Deco</span>
      </div>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <p
              key={i}
              className={cn(
                "text-[14px] leading-relaxed text-foreground py-1",
                i > 0 && "mt-0.5",
              )}
            >
              {part.text}
            </p>
          );
        }
        const Icon = TOOL_ICONS[part.icon];
        return (
          <ToolCallShell
            key={i}
            icon={<Icon />}
            title={part.name}
            summary={part.summary}
            state="idle"
            latency={part.latency}
          />
        );
      })}
    </div>
  );
}

export function DemoAgentChat({ messages }: { messages: DemoChatMessage[] }) {
  return (
    <div className="flex flex-col gap-4 overflow-y-auto py-4">
      {messages.map((msg, i) => {
        if (msg.role === "user") {
          const text = msg.parts[0]?.type === "text" ? msg.parts[0].text : "";
          return <UserBubble key={i} text={text} />;
        }
        return <AssistantTurn key={i} message={msg} />;
      })}
    </div>
  );
}

/** Full-height panel that replaces the real chat panel in the workspace. */
export function DemoAgentChatPanel({ session }: { session: DemoSession }) {
  const statusText = session.workingStatus ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <DecoAvatar className="size-5" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-foreground">Deco</span>
          {statusText && (
            <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <span className="size-1.5 shrink-0 rounded-full bg-green-500" />
              {statusText}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={clearActiveChatSession}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {session.chat && <DemoAgentChat messages={session.chat} />}
      </div>

      <div className="shrink-0">
        <ChatInput />
      </div>
    </div>
  );
}

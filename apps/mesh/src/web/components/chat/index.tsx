import { cn } from "@deco/ui/lib/utils.ts";
import type { PropsWithChildren } from "react";
import { ActiveTaskProvider, ChatProvider, useChatStream } from "./context";

export { useChatTask } from "./context";
import { IceBreakers } from "./ice-breakers";
import { ChatInput } from "./input";
import { MessagePair, useMessagePairs } from "./message/pair.tsx";
import { NoAiProviderEmptyState } from "./no-ai-provider-empty-state";
import { CreditsEmptyState } from "./credits-empty-state";
import { CreditsExhaustedBanner } from "./credits-exhausted-banner";
import { CreditsEyebrow, NoCreditsEyebrow } from "./credits-eyebrow";
import { DecoChatSkeleton } from "./skeleton";
export type { VirtualMCPInfo } from "./select-virtual-mcp";
export type { ChatMessage, ChatStatus } from "./types.ts";

function ChatRoot({
  className,
  children,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div
      className={cn(
        "flex flex-col h-full w-full bg-background transform-[translateZ(0)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ChatMain({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={cn("flex-1 min-h-0 overflow-y-auto isolate", className)}>
      {children}
    </div>
  );
}

function ChatEmptyState({ children }: PropsWithChildren) {
  return (
    <div className="h-full w-full flex items-center justify-center max-w-2xl mx-auto">
      {children}
    </div>
  );
}

function ChatMessages() {
  const { messages, status } = useChatStream();
  const messagePairs = useMessagePairs(messages);
  const lastMessagePair = messagePairs.at(-1);

  const isStreaming = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const hasActiveUserAsk =
    !isStreaming &&
    lastMessage?.role === "assistant" &&
    lastMessage.parts
      .filter((p) => p.type === "tool-user_ask")
      .some((p) => p.state === "input-available");
  const hasActivePendingApprovals =
    !isStreaming &&
    lastMessage?.role === "assistant" &&
    lastMessage.parts.some(
      (p) => "state" in p && p.state === "approval-requested",
    );

  return (
    <div className="w-full min-w-0 max-w-full overflow-y-auto h-full overflow-x-hidden">
      <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
        {messagePairs.slice(0, -1).map((pair, index) => (
          <MessagePair
            key={`pair-${pair.user.id}`}
            pair={pair}
            isLastPair={false}
            status={index === messagePairs.length - 1 ? status : undefined}
          />
        ))}
      </div>
      {lastMessagePair && (
        <div
          className={cn(
            "min-h-full min-w-0 max-w-2xl mx-auto w-full",
            (hasActiveUserAsk || hasActivePendingApprovals) && "pb-60",
          )}
        >
          <MessagePair
            key={`pair-${lastMessagePair?.user.id}`}
            pair={lastMessagePair}
            isLastPair={true}
            status={status}
          />
        </div>
      )}
    </div>
  );
}

function ChatFooter({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div
      className={cn(
        "flex-none w-full mx-auto p-2 pt-0",
        "max-w-2xl min-w-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const Chat = Object.assign(ChatRoot, {
  Main: ChatMain,
  Messages: ChatMessages,
  EmptyState: ChatEmptyState,
  Footer: ChatFooter,
  Input: ChatInput,
  Provider: ChatProvider,
  ActiveTaskProvider: ActiveTaskProvider,
  Skeleton: DecoChatSkeleton,
  IceBreakers: IceBreakers,
  NoAiProviderEmptyState: NoAiProviderEmptyState,
  CreditsEmptyState: CreditsEmptyState,
  CreditsEyebrow: CreditsEyebrow,
  NoCreditsEyebrow: NoCreditsEyebrow,
  CreditsExhaustedBanner: CreditsExhaustedBanner,
});

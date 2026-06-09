import { cn } from "@deco/ui/lib/utils.ts";
import { useAutoScroll } from "@deco/ui/hooks/use-auto-scroll.ts";
import {
  useEffect,
  useRef,
  type PropsWithChildren,
  type RefObject,
} from "react";
import { ActiveTaskProvider, ChatProvider, useChatStream } from "./context";

export { useChatTask } from "./context";
import { IceBreakers } from "./ice-breakers";
import { HIGHLIGHT_COLLAPSED_HEIGHT_PX } from "./highlight/collapsible-highlight";
import { useHighlightCount } from "./highlight/use-highlight-count";
import { ChatInput } from "./input";
import { MessagePair, useMessagePairs } from "./message/pair.tsx";
import { NoAiProviderEmptyState } from "./no-ai-provider-empty-state";
import { CreditsEmptyState } from "./credits-empty-state";
import { CreditsExhaustedBanner } from "./credits-exhausted-banner";
import { CreditsEyebrow, NoCreditsEyebrow } from "./credits-eyebrow";
import { DecoChatSkeleton } from "./skeleton";
export type { VirtualMCPInfo } from "./select-virtual-mcp";
export type { ChatMessage, ChatStatus } from "./types.ts";

/**
 * Trigger `fetchOlderMessages` when the top sentinel enters the viewport,
 * and preserve scroll anchor when older messages prepend.
 *
 * Anchor preservation:
 *   Before fetch: capture scrollHeight + scrollTop of the scroll container.
 *   After messages commit: scrollTop += (newScrollHeight - oldScrollHeight).
 *
 * Without this, prepending pages would yank the user away from the message
 * they were reading.
 */
function useTopSentinel({
  scrollRef,
  sentinelRef,
  hasMoreOlder,
  isFetchingOlder,
  fetchOlderMessages,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
  hasMoreOlder: boolean;
  isFetchingOlder: boolean;
  fetchOlderMessages: () => Promise<void>;
}) {
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- IntersectionObserver lifecycle binds to DOM nodes; ref-based effect is the natural fit
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollRef.current;
    if (!sentinel || !scroller) return;
    if (!hasMoreOlder) return;

    const observer = new IntersectionObserver(
      async (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (isFetchingOlder) return;
        if (!hasMoreOlder) return;

        const prevHeight = scroller.scrollHeight;
        const prevTop = scroller.scrollTop;
        await fetchOlderMessages();
        // After the React commit, the scroll container has grown. Re-anchor.
        requestAnimationFrame(() => {
          const newHeight = scroller.scrollHeight;
          scroller.scrollTop = prevTop + (newHeight - prevHeight);
        });
      },
      { root: scroller, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    scrollRef,
    sentinelRef,
    hasMoreOlder,
    isFetchingOlder,
    fetchOlderMessages,
  ]);
}

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
    <div className="min-h-full shrink-0 w-full flex items-center justify-center max-w-2xl mx-auto py-10">
      {children}
    </div>
  );
}

function ChatMessages() {
  const {
    messages,
    status,
    hasMoreOlder,
    isFetchingOlder,
    fetchOlderMessages,
    isStreaming,
  } = useChatStream();
  const messagePairs = useMessagePairs(messages);
  const lastMessagePair = messagePairs.at(-1);
  const highlightCount = useHighlightCount();

  // Reserve `n × h + 16px` of bottom padding so that, when every highlight
  // is collapsed, the last message sits a comfortable gap above the top of
  // the highlight stack. The 16px baseline keeps the last message off the
  // bottom edge even when no highlights are rendered. Expanded highlights
  // still cover content — the affordance is "collapse to read".
  const paddingBottom = highlightCount * HIGHLIGHT_COLLAPSED_HEIGHT_PX + 16;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useTopSentinel({
    scrollRef,
    sentinelRef,
    hasMoreOlder,
    isFetchingOlder,
    fetchOlderMessages,
  });

  // Bottom sentinel: pins the chat scroll to the bottom while the assistant
  // is streaming. Rendered as the literal last child of the scroller so its
  // y-position == scroller.scrollHeight — any upward scroll of 1px instantly
  // disengages tracking (via IntersectionObserver in container mode).
  // See: docs/superpowers/specs/2026-06-03-chat-autoscroll-sentinel-placement-design.md
  const lastAssistantParts = lastMessagePair?.assistant?.parts;
  const { sentinelRef: bottomSentinelRef } = useAutoScroll({
    containerRef: scrollRef,
    enabled: isStreaming,
    contentDeps: [lastAssistantParts?.length, lastAssistantParts?.at(-1)],
  });

  return (
    <div
      ref={scrollRef}
      data-chat-scroller
      className="w-full min-w-0 max-w-full overflow-y-auto h-full overflow-x-hidden"
    >
      <div style={{ paddingBottom }}>
        <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
          <div ref={sentinelRef} aria-hidden className="h-px" />
          {isFetchingOlder && (
            <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
              Loading older messages…
            </div>
          )}
          {messagePairs.slice(0, -1).map((pair, index) => (
            <MessagePair
              key={`pair-${pair.user?.id ?? pair.assistant?.id}`}
              pair={pair}
              isLastPair={false}
              status={index === messagePairs.length - 1 ? status : undefined}
            />
          ))}
        </div>
        {lastMessagePair && (
          <div className="min-h-full min-w-0 max-w-2xl mx-auto w-full">
            <MessagePair
              key={`pair-${lastMessagePair.user?.id ?? lastMessagePair.assistant?.id}`}
              pair={lastMessagePair}
              isLastPair={true}
              status={status}
            />
          </div>
        )}
      </div>
      <div ref={bottomSentinelRef} aria-hidden className="h-0" />
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

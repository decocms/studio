import { cn } from "@deco/ui/lib/utils.ts";
import {
  useEffect,
  useRef,
  type PropsWithChildren,
  type RefObject,
} from "react";
import {
  ActiveTaskProvider,
  ChatProvider,
  useChatStream,
  useChatTask,
} from "./context";

export { useChatTask } from "./context";
import { IceBreakers } from "./ice-breakers";
import { HIGHLIGHT_COLLAPSED_HEIGHT_PX } from "./highlight/collapsible-highlight";
import { useHighlightCount } from "./highlight/use-highlight-count";
import { ChatInput } from "./input";
import { MessagePair, useMessagePairs } from "./message/pair.tsx";
import { selectQueuedItems } from "./queue-items.ts";
import {
  useMessageQueue,
  useMessageQueueActions,
} from "./use-message-queue.ts";
import { SubtaskRunsProvider } from "./subtask-runs-context.tsx";
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
    stop,
    removeLocalMessage,
  } = useChatStream();
  const { taskId } = useChatTask();
  const messagePairs = useMessagePairs(messages);
  const highlightCount = useHighlightCount();

  // Queued-bubble affordances: which pairs are waiting behind the gate, and
  // which one (the FIFO head) can be promoted via "Run now".
  const queueItems = useMessageQueue(taskId ?? "");
  const queuedItems = selectQueuedItems(queueItems);
  const queuedIds = new Set(queuedItems.map((i) => i.messageId));
  const promotableId = queuedItems[0]?.messageId;
  const queueActions = useMessageQueueActions();

  // The "live" pair — the turn actually streaming (or the most recent
  // completed one) — is the last pair whose user message is NOT queued.
  // With messages queued behind a running turn the queued pairs sit at the
  // tail of `messagePairs`, so `.at(-1)` would misroute the live
  // `status`/`isLast` treatment onto a queued bubble: the streaming pair
  // would lose its GeneratingFooter/auto-scroll and could render "No
  // response was generated" MID-STREAM, while the scroll ref pinned the
  // queued bubble instead. Fallback (every pair queued — transient
  // optimistic states) keeps the old last-pair behavior. With zero queued
  // items this is exactly `length - 1`.
  const liveIndex = (() => {
    for (let i = messagePairs.length - 1; i >= 0; i--) {
      const uid = messagePairs[i]?.user?.id;
      if (!uid || !queuedIds.has(uid)) return i;
    }
    return messagePairs.length - 1;
  })();
  const livePair = messagePairs[liveIndex];

  const getQueuedInfo = (pair: MessagePair) =>
    pair.user && queuedIds.has(pair.user.id)
      ? { isQueued: true, isPromotable: pair.user.id === promotableId }
      : undefined;

  const handleRunNow = () => stop();

  const handleRemove = (pair: MessagePair) => async () => {
    if (!pair.user) return;
    const messageId = pair.user.id;
    // Server first: only drop the bubble once the cancel is confirmed (ok or
    // 404 = already gone). On failure the workflow is still alive — deleting
    // the local row would leave an invisible-but-live turn. The queue store's
    // optimistic drop inside `cancel` keeps the UI feedback instant, and its
    // finally-refresh restores the queue entry when the POST didn't land.
    const ok = await queueActions.cancel(taskId, messageId);
    if (ok) removeLocalMessage(messageId);
  };

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

  return (
    <SubtaskRunsProvider messages={messages}>
      <div
        ref={scrollRef}
        data-chat-scroller
        className="w-full min-w-0 max-w-full overflow-y-auto h-full overflow-x-hidden"
        style={{ paddingBottom }}
      >
        <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
          <div ref={sentinelRef} aria-hidden className="h-px" />
          {isFetchingOlder && (
            <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
              Loading older messages…
            </div>
          )}
          {/* Pairs before the live one: settled history, no live status. */}
          {messagePairs.slice(0, liveIndex).map((pair) => (
            <MessagePair
              key={`pair-${pair.user?.id ?? pair.assistant?.id}`}
              pair={pair}
              isLastPair={false}
              queuedInfo={getQueuedInfo(pair)}
              onRunNow={handleRunNow}
              onRemove={handleRemove(pair)}
            />
          ))}
        </div>
        {livePair && (
          <div className="min-h-full min-w-0 max-w-2xl mx-auto w-full">
            {/* The live pair: gets the streaming status, isLast semantics and
                the scroll-into-view treatment (via isLastPair inside). */}
            <MessagePair
              key={`pair-${livePair.user?.id ?? livePair.assistant?.id}`}
              pair={livePair}
              isLastPair={true}
              status={status}
              queuedInfo={getQueuedInfo(livePair)}
              onRunNow={handleRunNow}
              onRemove={handleRemove(livePair)}
            />
            {/* Queued tail: bubbles waiting behind the live turn — spinner +
                affordances only, never live status/isLast. */}
            {messagePairs.slice(liveIndex + 1).map((pair) => (
              <MessagePair
                key={`pair-${pair.user?.id ?? pair.assistant?.id}`}
                pair={pair}
                isLastPair={false}
                queuedInfo={getQueuedInfo(pair)}
                onRunNow={handleRunNow}
                onRemove={handleRemove(pair)}
              />
            ))}
          </div>
        )}
      </div>
    </SubtaskRunsProvider>
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

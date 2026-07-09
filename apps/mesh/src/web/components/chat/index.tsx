import { cn } from "@deco/ui/lib/utils.ts";
import {
  useEffect,
  useRef,
  type PropsWithChildren,
  type RefObject,
} from "react";
import { useStickToBottom } from "use-stick-to-bottom";
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
import { selectHiddenFromBody } from "./queue-items.ts";
import { useMessageQueue } from "./use-message-queue.ts";
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
  } = useChatStream();
  const { taskId } = useChatTask();

  // Queued turns render tray-side only (see queue-items.ts / the message
  // queue tray) — filter them out of the body BEFORE pairing so a queued
  // user message never shows up as a bubble, whether it arrived via the
  // optimistic enqueue or was fetched back from the DB on reload.
  const queueItems = useMessageQueue(taskId ?? "");
  const hiddenFromBody = selectHiddenFromBody(queueItems);
  const visibleMessages =
    hiddenFromBody.size === 0
      ? messages
      : messages.filter((m) => !hiddenFromBody.has(m.id));
  const messagePairs = useMessagePairs(visibleMessages);
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

  // `initial: false` — the pair-mount logic in pair.tsx owns landing scrolls
  // (dock-to-top on send, instant land-at-bottom for completed threads,
  // resumedFromBackground no-yank). The lib must not scroll on mount; it
  // only takes over once mounted, following growth during streaming.
  const stick = useStickToBottom({ initial: false });
  // Merge our own plain ref (read by useTopSentinel for the IntersectionObserver
  // root + scroll-anchor math) with the library's scrollRef callback, both
  // targeting the same `data-chat-scroller` element.
  //
  // Recreated on every render by design (not memoized): each call detaches
  // the previous node and reattaches the same one, which is idempotent, so
  // correctness never depends on the React Compiler memoizing this closure —
  // it's just a nice-to-have if it does.
  const setScrollerEl = (node: HTMLDivElement | null) => {
    scrollRef.current = node;
    stick.scrollRef(node);
  };

  return (
    <SubtaskRunsProvider messages={messages}>
      <div
        ref={setScrollerEl}
        data-chat-scroller
        // CONSTRAINT: this element's COMPUTED `overflow` shorthand must stay
        // in {auto, scroll} or use-stick-to-bottom's wheel-escape dies. The
        // lib's wheel handler walks ancestors testing
        // `["scroll","auto"].includes(getComputedStyle(el).overflow)` — the
        // SHORTHAND, not overflow-y alone. `overflow-y-auto` with an unset
        // overflow-x computes (CSS visible→auto coercion, since the two
        // longhands differ) to a single `"auto"` shorthand, which passes.
        // Adding `overflow-x-hidden` HERE would make it `"hidden auto"` and
        // fail the test, killing wheel-up escape on the primary chat
        // scroller. That's why horizontal clipping lives on the contentRef
        // wrapper below instead, not here.
        className="w-full min-w-0 max-w-full overflow-y-auto h-full [container-type:size]"
        style={{ paddingBottom }}
      >
        {/*
          Single wrapper around ALL scrollable content so the lib's
          ResizeObserver (on contentRef) sees growth from both the older
          pairs AND the streaming last pair. Height is left auto/content-
          driven (plain block) so it grows/shrinks with content — required
          for the ResizeObserver to fire on every size change.

          `overflow-x-hidden` carries the horizontal-clipping defense moved
          off the scroller above (see its comment): this wrapper never
          scrolls vertically (its height is unconstrained, so content never
          exceeds it), so its own computed shorthand ("hidden auto") is
          harmless — it's invisible to the lib's wheel-escape ancestor walk
          either way.

          `[container-type:size]` above (on the scroller) + `min-h-[100cqh]`
          below (on the last-pair wrapper) replace the old `min-h-full`:
          percentage `min-height` only resolves against a DIRECT ancestor
          with a definite height, but this wrapper's height is intentionally
          auto/content-driven, breaking that chain. Container query units
          (`cqh`) resolve against the nearest size-container ancestor
          (the scroller) regardless of how many auto-height boxes sit in
          between, so "last pair >= one viewport tall" still holds — the
          invariant pair.tsx's dock-to-top scroll depends on (docked-at-top
          == scrolled-to-bottom for short replies). Verified in a live
          browser: identical scrollHeight/scrollTop math to the pre-refactor
          single-level min-h-full, with or without the highlight-stack's
          inline paddingBottom on the scroller.
        */}
        <div ref={stick.contentRef} className="overflow-x-hidden">
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
            <div className="min-h-[100cqh] min-w-0 max-w-2xl mx-auto w-full">
              <MessagePair
                key={`pair-${lastMessagePair.user?.id ?? lastMessagePair.assistant?.id}`}
                pair={lastMessagePair}
                isLastPair={true}
                status={status}
              />
            </div>
          )}
        </div>
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

import { cn } from "@deco/ui/lib/utils.ts";
import { useRef } from "react";
import type { ChatMessage, ChatStatus } from "../types.ts";
import { MessageAssistant } from "./assistant.tsx";
import { MessageUser } from "./user.tsx";

export interface MessagePair {
  user: ChatMessage | null;
  assistant: ChatMessage | null;
}

/**
 * Converts a flat array of messages into user/assistant pairs.
 *
 * - User message + following assistant → paired together.
 * - User message with no following assistant → { user, assistant: null }.
 * - Assistant message with no preceding user (onboarding welcomes, etc.) →
 *   { user: null, assistant } on its own.
 */
export function useMessagePairs(messages: ChatMessage[]): MessagePair[] {
  const pairs: MessagePair[] = [];

  const filtered = messages.filter((m) => m.role !== "system");

  for (let i = 0; i < filtered.length; i++) {
    const message = filtered[i];

    if (!message) continue;

    if (message.role === "user") {
      const nextMessage = filtered[i + 1];

      if (nextMessage && nextMessage.role === "assistant") {
        pairs.push({ user: message, assistant: nextMessage });
        i++;
      } else {
        pairs.push({ user: message, assistant: null });
      }
    } else if (message.role === "assistant") {
      pairs.push({ user: null, assistant: message });
    }
  }

  return pairs;
}

interface MessagePairProps {
  pair: MessagePair;
  isLastPair: boolean;
  status?: ChatStatus;
}

export function MessagePair({ pair, isLastPair, status }: MessagePairProps) {
  const pairRef = useRef<HTMLDivElement>(null);
  /**
   * Initial-scroll once per MessagePair mount. The ref callback below fires
   * on every render (its identity is unstable by design), so this gate keeps
   * `scrollIntoView` / scroll-to-bottom from re-firing on every commit during
   * streaming — the sticky `top-4` on MessageUser keeps the user message
   * pinned visually without re-scrolling.
   */
  const didInitialScroll = useRef(false);

  const scrollToPair = () => {
    if (pairRef.current) {
      pairRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  };

  const handlePairRef = (node: HTMLDivElement | null) => {
    pairRef.current = node;
    if (!isLastPair || !node || didInitialScroll.current) return;
    didInitialScroll.current = true;

    // Active run: pin the user message at the top so the streaming assistant
    // content reveals beneath it. Matches the historical behavior.
    if (status === "submitted" || status === "streaming") {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    // Completed thread on open: land at the bottom of the assistant content
    // (latest content visible) — the standard chat-UI anchor. Walk up to the
    // chat scroll container by data attribute rather than threading a ref
    // through props.
    const scroller = node.closest<HTMLElement>("[data-chat-scroller]");
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    } else {
      // Fallback: if the marker isn't present, at least put the last pair
      // start in view rather than leaving the scroller at zero.
      node.scrollIntoView({ behavior: "instant", block: "start" });
    }
  };

  return (
    <div
      ref={handlePairRef}
      className={cn("flex flex-col pb-2 sm:pb-2", !pair.user && "pt-8 sm:pt-6")}
    >
      {pair.user && (
        <>
          <div className="sticky top-0 z-50 w-full h-4 bg-background" />
          <div className="sticky mb-8 sm:mb-6 top-4 z-50">
            <MessageUser message={pair.user} onScrollToPair={scrollToPair} />
          </div>
        </>
      )}
      <MessageAssistant
        message={pair.assistant}
        status={status}
        isLast={isLastPair}
      />
    </div>
  );
}

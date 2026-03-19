import { cn } from "@deco/ui/lib/utils.ts";
import { useRef } from "react";
import type { ChatMessage, ChatStatus } from "../types.ts";
import { MessageAssistant } from "./assistant.tsx";
import { MessageUser } from "./user.tsx";

export interface MessagePair {
  user: ChatMessage;
  assistant: ChatMessage | null;
}

/**
 * Converts a flat array of messages into user/assistant pairs.
 *
 * Pairing logic:
 * - Each user message creates a new pair
 * - The following assistant message (if any) is paired with it
 * - Orphaned assistant messages (no preceding user) are ignored
 *
 * Examples:
 * - [user, assistant] → [[user, assistant]]
 * - [user, user, assistant] → [[user, null], [user, assistant]]
 * - [user, assistant, user] → [[user, assistant], [user, null]]
 * - [assistant, user, assistant] → [[user, assistant]] (first assistant ignored)
 */
export function useMessagePairs(messages: ChatMessage[]): MessagePair[] {
  const pairs: MessagePair[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (!message) continue;

    if (message.role === "user") {
      // Look ahead for the next message
      const nextMessage = messages[i + 1];

      if (nextMessage && nextMessage.role === "assistant") {
        // Pair with the following assistant message
        pairs.push({ user: message, assistant: nextMessage });
        // Skip the assistant message in the next iteration
        i++;
      } else {
        // No assistant follows - create pair with null (pending or no response)
        pairs.push({ user: message, assistant: null });
      }
    }
    // Orphaned assistant messages (no preceding user) are ignored
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

    if (isLastPair) {
      node?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div ref={handlePairRef} className={cn("flex flex-col pb-2 sm:pb-2")}>
      {/* Sticky overlay to prevent scrolling content from appearing above the user message */}
      <div className="sticky top-0 z-50 w-full h-4 bg-background" />
      <div className="sticky mb-8 sm:mb-6 top-4 z-50">
        <MessageUser message={pair.user} onScrollToPair={scrollToPair} />
      </div>
      {/* Single MessageAssistant - handles all states internally */}
      <MessageAssistant
        message={pair.assistant}
        status={status}
        isLast={isLastPair}
      />
    </div>
  );
}

"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRef, useEffect, useState } from "react";
import { ChatMessages } from "@/components/chat-messages";
import { ChatInput } from "@/components/chat-input";

const transport = new DefaultChatTransport({
  api: "/api/chat",
});

const ICE_BREAKERS = [
  "I'd like a way to see which MCP tools are most used",
  "Can we add keyboard shortcuts to the chat?",
  "I want to export my conversation history",
];

function EmptyState({ onSelect }: { onSelect: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-8 text-center px-4 py-12">
      <div className="flex flex-col items-center gap-3">
        <div className="size-14 rounded-2xl bg-primary/10 flex items-center justify-center">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-primary"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-foreground">
          Request a Feature
        </h1>
        <p className="text-muted-foreground text-sm max-w-md leading-relaxed">
          Describe a feature you&apos;d like to see in MCP Mesh. I&apos;ll help
          you shape it into a clear plan and create a GitHub issue.
        </p>
      </div>

      <div className="flex flex-col gap-2 w-full max-w-md">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
          Try one of these
        </p>
        {ICE_BREAKERS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onSelect(text)}
            className="text-left text-sm px-4 py-3 rounded-xl border border-border bg-card hover:bg-accent hover:border-accent-foreground/10 transition-colors cursor-pointer"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function FeatureRequestPage() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");

  const { messages, sendMessage, status, stop } = useChat({
    transport,
  });

  const isStreaming = status === "streaming" || status === "submitted";
  const isEmpty = messages.length === 0;

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage({ text });
  };

  const handleIceBreaker = (text: string) => {
    setInput("");
    sendMessage({ text });
  };

  return (
    <div className="flex flex-col h-dvh bg-background">
      {/* Header */}
      <header className="flex-none border-b border-border px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-primary"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-medium text-foreground">
              MCP Mesh — Feature Request
            </h1>
            <p className="text-xs text-muted-foreground">
              Describe your idea and we&apos;ll shape it into a plan
            </p>
          </div>
        </div>
      </header>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-2xl mx-auto px-4">
          {isEmpty ? (
            <EmptyState onSelect={handleIceBreaker} />
          ) : (
            <div className="py-6">
              <ChatMessages messages={messages} isStreaming={isStreaming} />
            </div>
          )}
        </div>
      </div>

      {/* Input area */}
      <div className="flex-none border-t border-border bg-background">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={handleSend}
            onStop={stop}
            isStreaming={isStreaming}
          />
          <p className="text-[10px] text-muted-foreground/60 text-center mt-2">
            AI-powered feature planning. Responses may not always be accurate.
          </p>
        </div>
      </div>
    </div>
  );
}

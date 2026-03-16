"use client";

import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { MessageContent } from "./message-content";

const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  get_file_contents: "Reading file",
  search_code: "Searching code",
  get_repository_tree: "Browsing project structure",
  list_commits: "Checking recent changes",
  search_issues: "Searching existing issues",
  list_issues: "Browsing issues",
  issue_write: "Creating issue",
  get_me: "Checking context",
  GATEWAY_SEARCH_TOOLS: "Finding tools",
  GATEWAY_DESCRIBE_TOOLS: "Checking tools",
  GATEWAY_CALL_TOOL: "Using tool",
};

function getToolLabel(part: { type: string }): string {
  // For dynamic tools, toolName is a direct property
  // For static tools, the name is in the type: "tool-{name}"
  const toolName =
    "toolName" in part && typeof part.toolName === "string"
      ? part.toolName
      : part.type.startsWith("tool-")
        ? part.type.slice(5)
        : part.type;
  return FRIENDLY_TOOL_NAMES[toolName] ?? "Working";
}

function ToolCallIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
      <div className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse" />
      <span>{label}...</span>
    </div>
  );
}

function UserMessage({ message }: { message: UIMessage }) {
  const textParts = message.parts.filter((p) => p.type === "text");
  const text = textParts
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");

  if (!text) return null;

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary text-primary-foreground px-4 py-2.5 text-sm">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  isLast,
  isStreaming,
}: {
  message: UIMessage;
  isLast: boolean;
  isStreaming: boolean;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-1">
        {message.parts.map((part, i) => {
          if (part.type === "text" && part.text) {
            return (
              <div
                key={i}
                className="rounded-2xl rounded-bl-md bg-card border border-border px-4 py-2.5 text-sm"
              >
                <MessageContent content={part.text} />
              </div>
            );
          }
          if (isToolUIPart(part) && isLast) {
            return <ToolCallIndicator key={i} label={getToolLabel(part)} />;
          }
          return null;
        })}
        {isLast && isStreaming && message.parts.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <div className="flex gap-1">
              <div className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
              <div className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
              <div className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
            </div>
            <span>Thinking...</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatMessages({
  messages,
  isStreaming,
}: {
  messages: UIMessage[];
  isStreaming: boolean;
}) {
  if (messages.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {messages.map((message, index) => {
        const isLast = index === messages.length - 1;
        if (message.role === "user") {
          return <UserMessage key={message.id} message={message} />;
        }
        if (message.role === "assistant") {
          return (
            <AssistantMessage
              key={message.id}
              message={message}
              isLast={isLast}
              isStreaming={isStreaming}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

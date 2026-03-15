import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Lightbulb01, Stars01, Target04 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { type ReactNode, useEffect, useState } from "react";
import { ToolCallShell } from "./parts/tool-call-part/common.tsx";
import type { ChatMessage, TiptapDoc } from "../types.ts";
import { MessageStatsBar } from "../usage-stats.tsx";
import { MessageTextPart } from "./parts/text-part.tsx";
import {
  ConnectionAuthPart,
  GenericToolCallPart,
  SubtaskPart,
  UserAskPart,
} from "./parts/tool-call-part/index.ts";
import { SmartAutoScroll } from "./smart-auto-scroll.tsx";
import { type DataParts, useFilterParts } from "./use-filter-parts.ts";
import { addUsage, emptyUsageStats } from "@decocms/mesh-sdk";
import { useChatStable } from "../context";

type ThinkingStage = "planning" | "thinking";

interface ThinkingStageConfig {
  icon: ReactNode;
  label: string;
}

const THINKING_STAGES: Record<ThinkingStage, ThinkingStageConfig> = {
  planning: {
    icon: (
      <Target04
        className="text-muted-foreground shrink-0 animate-pulse"
        size={14}
      />
    ),
    label: "Planning next moves",
  },
  thinking: {
    icon: (
      <Stars01
        className="text-muted-foreground shrink-0 animate-pulse"
        size={14}
      />
    ),
    label: "Thinking",
  },
};

const PLANNING_DURATION = 1200;

function TypingIndicator() {
  const [stage, setStage] = useState<ThinkingStage>("planning");

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const planningTimer = setTimeout(() => {
      setStage("thinking");
    }, PLANNING_DURATION);

    return () => {
      clearTimeout(planningTimer);
    };
  }, []);

  const config = THINKING_STAGES[stage];

  return (
    <div className="flex items-center gap-1.5 py-2 opacity-60">
      <span className="flex items-center gap-1.5">
        {config.icon}
        <span className="text-[14px] text-muted-foreground shimmer">
          {config.label}...
        </span>
      </span>
    </div>
  );
}

function LiveTimer({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - since);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- interval required for live elapsed timer
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - since), 100);
    return () => clearInterval(id);
  }, [since]);

  return (
    <span className="tabular-nums text-sm font-mono text-muted-foreground/50">
      {(elapsed / 1000).toFixed(1)}s
    </span>
  );
}

function GeneratingFooter({ startedAt }: { startedAt: number }) {
  return (
    <div className="flex items-center gap-1 mt-1 pb-1 text-muted-foreground/40 select-none">
      <span className="text-sm">·</span>
      <LiveTimer since={startedAt} />
    </div>
  );
}

function ThoughtSummary({
  duration,
  parts,
  isStreaming,
}: {
  duration: number | null;
  parts: ReasoningPart[];
  isStreaming: boolean;
}) {
  const allPartsRedacted = parts.every((part) =>
    part.text?.includes("REDACTED"),
  );

  const thoughtMessage = duration
    ? duration / 1000 > 1
      ? `Thought for ${(duration / 1000).toFixed(1)}s`
      : "Thought"
    : "Thought";

  const rawText = parts
    .map((p) => p.text ?? "")
    .join(" ")
    .trim();
  const summary =
    !allPartsRedacted && rawText
      ? rawText.length > 100
        ? rawText.slice(0, 100) + "…"
        : rawText
      : undefined;

  const fullText = parts.map((p) => p.text ?? "").join("\n\n");
  const detail = !allPartsRedacted && fullText.trim() ? fullText : null;

  const latency =
    !isStreaming && duration != null ? duration / 1000 : undefined;

  return (
    <ToolCallShell
      icon={
        isStreaming ? (
          <Stars01 className="size-4" />
        ) : (
          <Lightbulb01 className="size-4" />
        )
      }
      title={isStreaming ? "Thinking..." : thoughtMessage}
      summary={summary}
      detail={detail}
      state={isStreaming ? "loading" : "idle"}
      detailVariant="prose"
      latency={latency}
      forceOpen={isStreaming}
    />
  );
}

type MessagePart = ChatMessage["parts"][number];

type ReasoningPart = Extract<MessagePart, { type: "reasoning" }>;

/**
 * Returns true for parts that should be rendered in the message.
 * Data parts (metadata, suggestions) and invisible parts are filtered out
 * so they don't cause index-based key shifts during streaming.
 */
function isVisiblePart(part: MessagePart): boolean {
  switch (part.type) {
    case "reasoning":
    case "step-start":
    case "file":
    case "source-url":
    case "source-document":
    case "data-tool-metadata":
    case "data-tool-subtask-metadata":
    case "data-prompt-suggestion":
      return false;
    default:
      if (part.type.startsWith("data-") && part.type !== "data-connection-auth")
        return false;
      return true;
  }
}

function getPartKey(part: MessagePart, messageId: string, index: number) {
  if ("toolCallId" in part && part.toolCallId) return part.toolCallId;
  return `${messageId}-${part.type}-${index}`;
}

function PlanApprovalActions() {
  const { sendMessage, setPlanMode } = useChatStable();

  const handleApprove = () => {
    setPlanMode(false);
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "The plan looks good. Please implement it.",
            },
          ],
        },
      ],
    };
    void sendMessage(doc);
  };

  return (
    <div className="flex items-center gap-2 mt-3 pt-3 border-t border-purple-500/20">
      <Button
        size="sm"
        onClick={handleApprove}
        className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-7"
      >
        Approve &amp; Implement
      </Button>
      <span className="text-xs text-muted-foreground">
        or send a message with feedback
      </span>
    </div>
  );
}

interface MessageAssistantProps {
  message: ChatMessage | null;
  status?: "streaming" | "submitted" | "ready" | "error";
  className?: string;
  isLast: boolean;
  isPlanMode?: boolean;
}

interface MessagePartProps {
  part: MessagePart;
  id: string;
  usageStats?: ReactNode;
  dataParts: DataParts;
  isLoading?: boolean;
  isLastMessage?: boolean;
}

function MessagePart({
  part,
  id,
  usageStats,
  dataParts,
  isLoading,
  isLastMessage,
}: MessagePartProps) {
  const getMeta = (toolCallId: string) =>
    dataParts.toolMetadata.get(toolCallId);
  const getSubtaskMeta = (toolCallId: string) =>
    dataParts.toolSubtaskMetadata.get(toolCallId);

  switch (part.type) {
    case "dynamic-tool":
      return (
        <GenericToolCallPart
          part={part}
          annotations={getMeta(part.toolCallId)?.annotations}
          latency={getMeta(part.toolCallId)?.latencySeconds}
          isLastMessage={isLastMessage}
          toolMeta={getMeta(part.toolCallId)?._meta}
        />
      );
    case "tool-user_ask":
      return (
        <UserAskPart
          part={part}
          latency={getMeta(part.toolCallId)?.latencySeconds}
        />
      );
    case "tool-subtask":
      return (
        <SubtaskPart
          part={part}
          subtaskMeta={getSubtaskMeta(part.toolCallId)}
          annotations={getMeta(part.toolCallId)?.annotations}
          latency={getMeta(part.toolCallId)?.latencySeconds}
        />
      );
    case "text":
      return (
        <MessageTextPart
          id={id}
          part={part}
          extraActions={usageStats}
          copyable
          alwaysShowActions={!!usageStats && !isLoading}
        />
      );
    case "reasoning":
      return null;
    case "step-start":
    case "file":
    case "source-url":
    case "source-document":
      return null;
    case "data-tool-metadata":
    case "data-tool-subtask-metadata":
    case "data-prompt-suggestion":
      return null;
    case "data-connection-auth": {
      // Auth card emitted via MCP elicitation (Claude Code path)
      const authData = (part as { data?: Record<string, unknown> }).data;
      if (authData) {
        const connectionId = (authData.connectionId as string) ?? "";
        return (
          <ConnectionAuthPart
            part={
              {
                type: "tool-CONNECTION_AUTHENTICATE" as ToolUIPart["type"],
                toolCallId: `elicit-${connectionId}`,
                state: "output-available" as const,
                output: {
                  connection_id: connectionId,
                  title: (authData.title as string) ?? "Authenticate",
                  icon: (authData.icon as string) ?? null,
                  description: null,
                  connection_url: (authData.connectionUrl as string) ?? null,
                  status: "inactive",
                  needs_auth: true,
                  auth_type: "oauth",
                },
              } as ToolUIPart
            }
          />
        );
      }
      return null;
    }
    default: {
      const fallback = part as ToolUIPart;
      // Inline auth card for CONNECTION_AUTHENTICATE tool
      if (fallback.type === "tool-CONNECTION_AUTHENTICATE") {
        return (
          <ConnectionAuthPart
            part={fallback}
            latency={getMeta(fallback.toolCallId)?.latencySeconds}
          />
        );
      }
      if (fallback.type.startsWith("tool-")) {
        const toolCallId = (fallback as ToolUIPart).toolCallId;
        const meta = dataParts.toolMetadata.get(toolCallId);
        return (
          <GenericToolCallPart
            part={fallback}
            annotations={meta?.annotations}
            latency={meta?.latencySeconds}
            isLastMessage={isLastMessage}
            toolMeta={meta?._meta}
          />
        );
      }
      if (fallback.type.startsWith("data-")) {
        return null;
      }
      throw new Error(`Unknown part type: ${fallback.type}`);
    }
  }
}

function EmptyAssistantState() {
  return (
    <div className="text-[14px] text-muted-foreground/60 py-2">
      No response was generated
    </div>
  );
}

function Container({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "w-full min-w-0 group relative flex items-start gap-4 px-4 z-20 text-foreground flex-row",
        className,
      )}
    >
      <div className="flex flex-col min-w-0 w-full items-start">
        <div className="w-full min-w-0 not-only:rounded-2xl text-[14px] wrap-break-word overflow-wrap-anywhere bg-transparent">
          {children}
        </div>
      </div>
    </div>
  );
}

function PromptSuggestions({ suggestions }: { suggestions: string[] }) {
  const { sendMessage } = useChatStable();

  if (suggestions.length === 0) return null;

  const handleClick = (suggestion: string) => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: suggestion }] },
      ],
    };
    void sendMessage(doc);
  };

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => handleClick(suggestion)}
          className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-full hover:bg-accent/50 transition-colors cursor-pointer"
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

export function MessageAssistant({
  message,
  status,
  className,
  isLast = false,
  isPlanMode = false,
}: MessageAssistantProps) {
  const isStreaming = status === "streaming";
  const isSubmitted = status === "submitted";
  const isLoading = isStreaming || isSubmitted;

  // Track when this message's generation started for the live elapsed timer
  const [startedAt, setStartedAt] = useState<number | null>(() =>
    isLoading ? Date.now() : null,
  );
  const [prevIsLoading, setPrevIsLoading] = useState(isLoading);
  if (prevIsLoading !== isLoading) {
    setPrevIsLoading(isLoading);
    if (isLoading) {
      setStartedAt(Date.now());
    } else {
      setStartedAt(null);
    }
  }

  // Handle null message or empty parts
  const hasContent = message !== null && message.parts.length > 0;

  // Use hook to extract reasoning and data parts in a single pass
  const { reasoningParts, dataParts } = useFilterParts(message);
  const hasReasoning = reasoningParts.length > 0;

  const reasoningStartAt = message?.metadata?.reasoning_start_at
    ? new Date(message.metadata.reasoning_start_at)
    : null;
  const reasoningEndAt = message?.metadata?.reasoning_end_at
    ? new Date(message.metadata.reasoning_end_at)
    : new Date();

  const duration =
    reasoningStartAt !== null
      ? reasoningEndAt.getTime() - reasoningStartAt.getTime()
      : null;

  // Filter to only visible parts to avoid index-based key shifts from data/metadata parts
  const visibleParts = hasContent ? message.parts.filter(isVisiblePart) : [];

  return (
    <Container className={className}>
      {hasContent ? (
        <div className="flex flex-col gap-2">
          {isPlanMode && (
            <div className="flex items-center gap-1.5 text-purple-500 text-xs font-medium">
              <Target04 size={14} />
              <span>Plan</span>
            </div>
          )}
          <div
            className={cn(
              "flex flex-col gap-2",
              isPlanMode && "border-l-2 border-purple-500/30 pl-3",
            )}
          >
            {hasReasoning && (
              <ThoughtSummary
                duration={duration}
                parts={reasoningParts}
                isStreaming={isStreaming}
              />
            )}
            {visibleParts.map((part, index) => {
              const isLastPart = index === visibleParts.length - 1;
              const usage = isLastPart
                ? addUsage(emptyUsageStats(), message.metadata?.usage)
                : null;

              return (
                <MessagePart
                  key={getPartKey(part, message.id, index)}
                  part={part}
                  id={message.id}
                  usageStats={
                    isLastPart && (
                      <MessageStatsBar usage={usage} duration={duration} />
                    )
                  }
                  dataParts={dataParts}
                  isLoading={isLoading}
                  isLastMessage={isLast}
                />
              );
            })}
            {isLast && !isLoading && dataParts.promptSuggestions.length > 0 && (
              <PromptSuggestions suggestions={dataParts.promptSuggestions} />
            )}
            {isLast && isLoading && startedAt !== null && (
              <GeneratingFooter startedAt={startedAt} />
            )}
          </div>
          {isLast && !isLoading && isPlanMode && <PlanApprovalActions />}
        </div>
      ) : isLoading ? (
        <TypingIndicator />
      ) : (
        <EmptyAssistantState />
      )}
      {/* Smart auto-scroll sentinel - only rendered for the last message during streaming */}
      {isLast && isStreaming && <SmartAutoScroll parts={message?.parts} />}
    </Container>
  );
}

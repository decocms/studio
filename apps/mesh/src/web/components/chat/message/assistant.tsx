import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ChevronRight,
  Lightbulb01,
  Stars01,
  Target04,
} from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MemoizedMarkdown } from "../markdown.tsx";
import type { ChatMessage } from "../types.ts";
import { MessageUsageStats } from "../usage-stats.tsx";
import { MessageTextPart } from "./parts/text-part.tsx";
import {
  GenericToolCallPart,
  SubtaskPart,
  UserAskPart,
} from "./parts/tool-call-part/index.ts";
import { SmartAutoScroll } from "./smart-auto-scroll.tsx";
import { type DataParts, useFilterParts } from "./use-filter-parts.ts";
import { addUsage, emptyUsageStats } from "@decocms/mesh-sdk";

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
        <span className="text-[15px] text-muted-foreground shimmer">
          {config.label}...
        </span>
      </span>
    </div>
  );
}

function ThoughtSummaryHeader({
  isStreaming,
  thoughtMessage,
  isExpanded,
  reasoningTokens,
}: {
  isStreaming: boolean;
  thoughtMessage: string;
  isExpanded: boolean;
  reasoningTokens: number;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {isStreaming ? (
        <Stars01 className="text-muted-foreground shrink-0 shimmer" size={14} />
      ) : (
        <span className="relative w-[14px] h-[14px] shrink-0">
          <ChevronRight
            className={cn(
              "absolute inset-0 text-muted-foreground transition-transform",
              isExpanded && "rotate-90",
              "opacity-0 group-hover/thought-summary:opacity-100",
            )}
            size={14}
          />
          <Lightbulb01
            className="absolute inset-0 text-muted-foreground shrink-0 opacity-100 group-hover/thought-summary:opacity-0 transition-opacity"
            size={14}
          />
        </span>
      )}
      <span
        className={cn(
          "text-[15px] text-muted-foreground",
          isStreaming && "shimmer",
        )}
      >
        {isStreaming ? "Thinking..." : thoughtMessage}
      </span>
      <span className="text-[10px] font-mono tabular-nums text-muted-foreground/50 ml-2 mt-px">
        {reasoningTokens.toLocaleString()} tokens
      </span>
    </span>
  );
}

function ThoughtSummary({
  duration,
  parts,
  reasoningTokens,
  id,
  isStreaming,
}: {
  duration: number | null;
  parts: ReasoningPart[];
  reasoningTokens: number;
  id: string;
  isStreaming: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll within the thought summary container when new parts arrive
  // Uses scrollTop instead of scrollIntoView to avoid conflicts with parent scrolling
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- Content change tracking requires useEffect
  useEffect(() => {
    if (isStreaming && scrollContainerRef.current) {
      // Scroll to bottom of the internal container
      scrollContainerRef.current.scrollTop =
        scrollContainerRef.current.scrollHeight;
    }
  }, [parts, isStreaming]);

  const thoughtMessage = duration
    ? duration / 1000 > 1
      ? `Thought for ${(duration / 1000).toFixed(1)}s`
      : "Thought"
    : "Thought";

  const allPartsRedacted = parts.every((part) =>
    part.text?.includes("REDACTED"),
  );

  if (allPartsRedacted) {
    return (
      <div className="mb-2">
        <ThoughtSummaryHeader
          isStreaming={isStreaming}
          thoughtMessage={thoughtMessage}
          isExpanded={isExpanded}
          reasoningTokens={reasoningTokens}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col mb-2">
      <Collapsible
        open={isStreaming || isExpanded}
        onOpenChange={!isStreaming ? setIsExpanded : undefined}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "group/thought-summary flex items-center gap-1.5 py-2 opacity-60 transition-opacity",
              !isStreaming && "cursor-pointer hover:opacity-100",
              isStreaming && "cursor-default",
            )}
          >
            <ThoughtSummaryHeader
              isStreaming={isStreaming}
              thoughtMessage={thoughtMessage}
              isExpanded={isExpanded}
              reasoningTokens={reasoningTokens}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden">
          <div className="relative">
            {/* Gradient overlay - only while streaming */}
            {isStreaming && (
              <div className="absolute top-0 left-0 right-0 h-16 bg-linear-to-b from-background to-transparent pointer-events-none z-10" />
            )}
            <div
              ref={scrollContainerRef}
              className="ml-[6px] border-l-2 pl-4 mt-1 mb-2 h-[100px] overflow-y-auto"
            >
              {parts.map((part, index) => {
                return (
                  <div
                    key={`${id}-reasoning-${index}`}
                    className="text-muted-foreground markdown-sm pb-2"
                  >
                    <MemoizedMarkdown
                      id={`${id}-reasoning-${index}`}
                      text={part.text}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

type MessagePart = ChatMessage["parts"][number];

type ReasoningPart = Extract<MessagePart, { type: "reasoning" }>;

interface MessageAssistantProps {
  message: ChatMessage | null;
  status?: "streaming" | "submitted" | "ready" | "error";
  className?: string;
  isLast: boolean;
}

interface MessagePartProps {
  part: MessagePart;
  id: string;
  usageStats?: ReactNode;
  dataParts: DataParts;
}

function MessagePart({ part, id, usageStats, dataParts }: MessagePartProps) {
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
      return null;
    default: {
      const fallback = part as ToolUIPart;
      if (fallback.type.startsWith("tool-")) {
        const toolCallId = (fallback as ToolUIPart).toolCallId;
        const meta = dataParts.toolMetadata.get(toolCallId);
        return (
          <GenericToolCallPart
            part={fallback}
            annotations={meta?.annotations}
            latency={meta?.latencySeconds}
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
    <div className="text-[15px] text-muted-foreground/60 py-2">
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
        <div className="w-full min-w-0 not-only:rounded-2xl text-[15px] wrap-break-word overflow-wrap-anywhere bg-transparent">
          {children}
        </div>
      </div>
    </div>
  );
}

export function MessageAssistant({
  message,
  status,
  className,
  isLast = false,
}: MessageAssistantProps) {
  const isStreaming = status === "streaming";
  const isSubmitted = status === "submitted";
  const isLoading = isStreaming || isSubmitted;

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

  return (
    <Container className={className}>
      {hasContent ? (
        <>
          {hasReasoning && (
            <ThoughtSummary
              duration={duration}
              parts={reasoningParts}
              id={message.id}
              isStreaming={isStreaming}
              reasoningTokens={message.metadata?.usage?.reasoningTokens ?? 0}
            />
          )}
          {message.parts.map((part, index) => {
            const isLastPart = index === message.parts.length - 1;
            const usage = isLastPart
              ? addUsage(emptyUsageStats(), message.metadata?.usage)
              : null;

            return (
              <MessagePart
                key={`${message.id}-${index}`}
                part={part}
                id={message.id}
                usageStats={isLastPart && <MessageUsageStats usage={usage} />}
                dataParts={dataParts}
              />
            );
          })}
        </>
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

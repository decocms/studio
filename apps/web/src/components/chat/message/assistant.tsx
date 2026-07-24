import { cn } from "@deco/ui/lib/utils.ts";
import {
  MessageTextSquare01,
  RefreshCw01,
  Stars01,
  Tool02,
} from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { type ReactNode, Suspense, useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import { ToolCallShell } from "./parts/tool-call-part/common.tsx";
import type { ChatMessage } from "../types.ts";
import { MessageStatsBar } from "../usage-stats.tsx";
import { MessageTextPart } from "./parts/text-part.tsx";
import { MessageTimestamp } from "./timestamp.tsx";
import {
  type ReasoningPart,
  GeneratingFooter,
  ThinkingState,
  ThoughtSummary,
} from "./thinking-indicator.tsx";
import {
  GenericToolCallPart,
  GenerateImagePart,
  TakeScreenshotPart,
  WebSearchPart,
  ProposePlanPart,
  SubtaskPart,
  SubtaskPartFallback,
  UserAskPart,
  BrandContextPart,
  BrandContextGetPart,
  BrandContextListPart,
  AgentCreatePart,
  AgentListPart,
  ConnectionListPart,
} from "./parts/tool-call-part/index.ts";
import { NextActionChip } from "./next-action-chip.tsx";
import { ThreadHtmlPreviews } from "./thread-html-previews.tsx";
import { MessageProducedFiles } from "./thread-outputs.tsx";
import {
  type DataParts,
  type RenderItem,
  useFilterParts,
} from "./use-filter-parts.ts";
import { addUsage, emptyUsageStats } from "@/sdk";
import { useOptionalChatStream, useOptionalChatTask } from "../context.tsx";
import { toEpochMs } from "../../../lib/format-time.ts";

type MessagePart = ChatMessage["parts"][number];

/** Minimum number of tool-call items required before collapsing kicks in. */
const COLLAPSE_THRESHOLD = 3;

/**
 * Categorise render items into "collapsible" (tool calls, reasoning) and
 * "tail" (final text parts that stay visible).  The tail is every item
 * from the *last* text part onward.
 */
function splitCollapsible(
  renderOrder: RenderItem[],
  parts: ChatMessage["parts"],
): { collapsed: RenderItem[]; tail: RenderItem[] } {
  // Find the last text-part index in renderOrder
  let lastTextIdx = -1;
  for (let i = renderOrder.length - 1; i >= 0; i--) {
    const item = renderOrder[i]!;
    if (item.kind === "part" && parts[item.index]?.type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  if (lastTextIdx === -1) {
    // No text parts at all – don't collapse
    return { collapsed: [], tail: renderOrder };
  }
  return {
    collapsed: renderOrder.slice(0, lastTextIdx),
    tail: renderOrder.slice(lastTextIdx),
  };
}

/** Count tool calls and messages in a set of render items. */
function collapsedCounts(
  items: RenderItem[],
  parts: ChatMessage["parts"],
): { toolCalls: number; messages: number } {
  let toolCalls = 0;
  let messages = 0;
  for (const item of items) {
    if (item.kind === "reasoning-group") {
      messages++;
    } else {
      const type = parts[item.index]?.type;
      if (type === "text") {
        messages++;
      } else if (
        (type === "dynamic-tool" || type?.startsWith("tool-")) &&
        type !== "tool-todo_write" &&
        type !== "tool-update_interests"
      ) {
        toolCalls++;
      }
    }
  }
  return { toolCalls, messages };
}

function CollapsedSectionTitle({
  toolCalls,
  messages,
}: {
  toolCalls: number;
  messages: number;
}) {
  const t = useT();
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      {toolCalls > 0 && (
        <>
          <Tool02 className="size-3.5 shrink-0" />
          <span>
            {t("chat.assistant.toolCallPlural", { count: toolCalls })}
            {messages > 0 ? "," : ""}
          </span>
        </>
      )}
      {messages > 0 && (
        <>
          <MessageTextSquare01 className="size-3.5 shrink-0" />
          <span>{t("chat.assistant.messagePlural", { count: messages })}</span>
        </>
      )}
    </span>
  );
}

function CollapsedSection({
  items,
  message,
  reasoningGroups,
  isReasoningActive,
  totalDuration,
  dataParts,
  isLoading,
  isLast,
}: {
  items: RenderItem[];
  message: ChatMessage;
  reasoningGroups: { parts: ReasoningPart[]; startIndex: number }[];
  isReasoningActive: boolean;
  totalDuration: number | null;
  dataParts: DataParts;
  isLoading: boolean;
  isLast: boolean;
}) {
  const { toolCalls, messages } = collapsedCounts(items, message.parts);

  if (toolCalls === 0 && messages === 0) return null;

  return (
    <ToolCallShell
      icon={null}
      alwaysChevron
      title={
        <CollapsedSectionTitle toolCalls={toolCalls} messages={messages} />
      }
      state="idle"
    >
      <div className="flex flex-col gap-3 sm:gap-2 pt-1">
        {items.map((item, idx) =>
          renderItem({
            item,
            renderIndex: idx,
            message,
            reasoningGroups,
            isReasoningActive,
            totalDuration,
            dataParts,
            isLoading,
            isLast,
            isLastVisiblePart: false,
          }),
        )}
      </div>
    </ToolCallShell>
  );
}

interface MessageAssistantProps {
  message: ChatMessage | null;
  /**
   * Top-level `created_at` of the user message that opened this turn. Used as
   * the anchor for the live elapsed-time chronometer so the value is stable
   * across page reload, thread switch, and SSE resume (the user row is
   * inserted once and never re-stamped). Null when there's no preceding user
   * message in the pair (assistant-initiated welcomes, async-research stubs),
   * in which case the chronometer falls back to `Date.now()` at mount.
   */
  turnStartedAt?: string | Date | null;
  status?: "streaming" | "submitted" | "ready" | "error";
  className?: string;
  isLast: boolean;
}

interface MessagePartProps {
  part: MessagePart;
  id: string;
  usageStats?: ReactNode;
  dataParts: DataParts;
  isLoading?: boolean;
  isLastMessage?: boolean;
}

/** Shared render function for a single RenderItem. */
function renderItem({
  item,
  renderIndex,
  message,
  reasoningGroups,
  isReasoningActive,
  totalDuration,
  dataParts,
  isLoading,
  isLast,
  isLastVisiblePart,
  renderOrder,
}: {
  item: RenderItem;
  renderIndex: number;
  message: ChatMessage;
  reasoningGroups: { parts: ReasoningPart[]; startIndex: number }[];
  isReasoningActive: boolean;
  totalDuration: number | null;
  dataParts: DataParts;
  isLoading: boolean;
  isLast: boolean;
  isLastVisiblePart: boolean;
  renderOrder?: RenderItem[];
}): ReactNode {
  if (item.kind === "reasoning-group") {
    const { group } = item;
    const isLastGroup = group === reasoningGroups[reasoningGroups.length - 1];
    const isGroupStreaming = isReasoningActive && isLastGroup;
    const hasText = group.parts.some((p) => p.text?.trim());
    if (!hasText && !isGroupStreaming) {
      return null;
    }
    const groupDuration = reasoningGroups.length === 1 ? totalDuration : null;
    return (
      <ThoughtSummary
        key={`${message.id}-reasoning-${group.startIndex}`}
        duration={groupDuration}
        parts={group.parts}
        isStreaming={isGroupStreaming}
      />
    );
  }

  const part = message.parts[item.index]!;
  const shouldShowUsage =
    isLastVisiblePart ||
    (renderOrder
      ? renderOrder.findLastIndex((r) => r.kind === "part") === renderIndex
      : false);
  const usage = shouldShowUsage
    ? addUsage(emptyUsageStats(), message.metadata?.usage)
    : null;

  return (
    <MessagePart
      key={`${message.id}-${item.index}`}
      part={part}
      id={message.id}
      usageStats={
        shouldShowUsage && (
          <MessageStatsBar usage={usage} duration={totalDuration} />
        )
      }
      dataParts={dataParts}
      isLoading={isLoading}
      isLastMessage={isLast}
    />
  );
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
          outputBytes={getMeta(part.toolCallId)?.outputBytes}
          isLastMessage={isLastMessage}
          toolMeta={getMeta(part.toolCallId)?._meta}
        />
      );
    case "tool-todo_write":
      return null;
    case "tool-update_interests":
      return null;
    case "tool-user_ask":
      return (
        <UserAskPart
          part={part}
          latency={getMeta(part.toolCallId)?.latencySeconds}
        />
      );
    case "tool-propose_plan":
      return <ProposePlanPart part={part} />;
    case "tool-generate_image":
      return (
        <GenerateImagePart
          part={part}
          latency={getMeta(part.toolCallId)?.latencySeconds}
        />
      );
    case "tool-take_screenshot":
      return (
        <TakeScreenshotPart
          part={part}
          latency={getMeta(part.toolCallId)?.latencySeconds}
        />
      );
    case "tool-web_search":
    case "tool-deep_research":
      return (
        <WebSearchPart
          part={part}
          latency={getMeta(part.toolCallId)?.latencySeconds}
          streamingText={dataParts.webSearchStreaming.get(part.toolCallId)}
        />
      );
    case "tool-subtask": {
      const subtaskProps = {
        part,
        subtaskMeta: getSubtaskMeta(part.toolCallId),
        annotations: getMeta(part.toolCallId)?.annotations,
        latency: getMeta(part.toolCallId)?.latencySeconds,
      };
      return (
        <Suspense fallback={<SubtaskPartFallback {...subtaskProps} />}>
          <SubtaskPart {...subtaskProps} />
        </Suspense>
      );
    }
    case "text":
      return (
        <MessageTextPart
          id={id}
          part={part}
          extraActions={usageStats}
          copyable
          alwaysShowActions={!!usageStats && !isLoading}
          animate={isLoading && isLastMessage}
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
    case "data-generate-image":
    case "data-web-search":
      return null;
    default: {
      const fallback = part as ToolUIPart;
      if (
        fallback.type === "tool-brand_context_setup" ||
        fallback.type === "tool-BRAND_CONTEXT_EXTRACT"
      ) {
        return (
          <BrandContextPart
            part={fallback}
            latency={getMeta(fallback.toolCallId)?.latencySeconds}
          />
        );
      }
      if (fallback.type === "tool-BRAND_CONTEXT_GET") {
        return (
          <BrandContextGetPart
            part={fallback}
            latency={getMeta(fallback.toolCallId)?.latencySeconds}
          />
        );
      }
      if (fallback.type === "tool-BRAND_CONTEXT_LIST") {
        return (
          <BrandContextListPart
            part={fallback}
            latency={getMeta(fallback.toolCallId)?.latencySeconds}
          />
        );
      }
      if (fallback.type === "tool-COLLECTION_VIRTUAL_MCP_CREATE") {
        return (
          <AgentCreatePart
            part={fallback}
            latency={getMeta(fallback.toolCallId)?.latencySeconds}
          />
        );
      }
      if (fallback.type === "tool-COLLECTION_VIRTUAL_MCP_LIST") {
        return (
          <AgentListPart
            part={fallback}
            latency={getMeta(fallback.toolCallId)?.latencySeconds}
          />
        );
      }
      if (fallback.type === "tool-COLLECTION_CONNECTIONS_LIST") {
        return (
          <ConnectionListPart
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
            outputBytes={meta?.outputBytes}
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

function EmptyAssistantState({
  isRunInProgress,
}: {
  isRunInProgress: boolean;
}) {
  const t = useT();
  if (isRunInProgress) {
    return (
      <div className="flex items-center gap-1.5 py-2 opacity-60">
        <span className="flex items-center gap-1.5">
          <Stars01
            className="text-muted-foreground shrink-0 animate-pulse"
            size={14}
          />
          <span className="text-[14px] text-muted-foreground shimmer">
            {t("chat.assistant.resumingTask")}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="text-[14px] text-muted-foreground/60 py-2">
      {t("chat.assistant.noResponseGenerated")}
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

export function MessageAssistant({
  message,
  turnStartedAt,
  status,
  className,
  isLast = false,
}: MessageAssistantProps) {
  const t = useT();
  const { isRunInProgress = false } = useOptionalChatStream() ?? {};
  const taskId = useOptionalChatTask()?.taskId ?? null;
  const isStreaming = status === "streaming";
  const isSubmitted = status === "submitted";
  const isLoading = isStreaming || isSubmitted;

  // Track when this turn started for the live elapsed-time chronometer.
  //
  // Anchor on the user message's top-level `created_at` (passed in via
  // `turnStartedAt` from MessagePair). This timestamp is set once when the
  // user row is inserted on the server and never re-stamped, so it survives
  // page reload, thread switch, and SSE resume cleanly — the chronometer
  // resumes counting from the real turn-start instead of restarting on
  // remount. It's also the most semantically meaningful anchor: the chron
  // shows how long the user has been waiting since *they* submitted.
  //
  // Client fallback (`Date.now()`) covers two cases:
  //   1. The brief optimistic-submit window where the user row exists locally
  //      but the server hasn't yet inserted it (no top-level `created_at`).
  //   2. Assistant-only pairs (welcomes, async-research stubs) where there's
  //      no preceding user message at all.
  const turnEpochMs = toEpochMs(turnStartedAt);
  const [clientFallbackStartedAt, setClientFallbackStartedAt] = useState<
    number | null
  >(() => (isLoading ? Date.now() : null));
  const [prevIsLoading, setPrevIsLoading] = useState(isLoading);
  if (prevIsLoading !== isLoading) {
    setPrevIsLoading(isLoading);
    setClientFallbackStartedAt(isLoading ? Date.now() : null);
  }
  const startedAt = turnEpochMs ?? clientFallbackStartedAt;

  // Use hook to extract reasoning groups, build render order, and data parts
  const { reasoningGroups, renderOrder, dataParts } = useFilterParts(message);
  const hasVisibleContent = message !== null && renderOrder.length > 0;

  // Reasoning is actively streaming only when the last part in the array
  // is a reasoning part (the model is currently inside a thinking block).
  const lastMessagePart =
    message && message.parts.length > 0
      ? message.parts[message.parts.length - 1]
      : null;
  const isReasoningActive =
    isStreaming && lastMessagePart?.type === "reasoning";

  const reasoningStartAt = message?.metadata?.reasoning_start_at
    ? new Date(message.metadata.reasoning_start_at)
    : null;
  const reasoningEndAt = message?.metadata?.reasoning_end_at
    ? new Date(message.metadata.reasoning_end_at)
    : new Date();

  const totalDuration =
    reasoningStartAt !== null
      ? reasoningEndAt.getTime() - reasoningStartAt.getTime()
      : null;

  // Determine whether to collapse intermediate parts.
  // Only collapse when not streaming and there are enough tool calls.
  // For the last message, also require the turn not to be paused on a
  // pending tool call (awaiting approval / user_ask / propose_plan / still
  // executing) — collapsing now would hide work about to grow further.
  // Derived from the message's parts rather than the session-scoped
  // `finishReason`, so server-loaded threads collapse too.
  const isTerminallyDone =
    !isLast ||
    !message ||
    !message.parts.some((part) => {
      const type = part.type;
      if (type !== "dynamic-tool" && !type?.startsWith("tool-")) return false;
      const state = (part as { state?: string }).state;
      return (
        state === "input-streaming" ||
        state === "input-available" ||
        state === "approval-requested"
      );
    });
  const shouldCollapse =
    !isLoading &&
    hasVisibleContent &&
    isTerminallyDone &&
    (() => {
      let toolCallCount = 0;
      for (const item of renderOrder) {
        if (item.kind === "part") {
          const type = message!.parts[item.index]?.type;
          if (type === "dynamic-tool" || type?.startsWith("tool-")) {
            toolCallCount++;
          }
        }
      }
      return toolCallCount >= COLLAPSE_THRESHOLD;
    })();

  const { collapsed, tail } = shouldCollapse
    ? splitCollapsible(renderOrder, message!.parts)
    : { collapsed: [] as RenderItem[], tail: renderOrder };

  return (
    <Container className={className}>
      {hasVisibleContent ? (
        <div className="flex flex-col gap-3 sm:gap-2">
          {message!.metadata?.resumedFromBackground && (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground/60 select-none">
              <RefreshCw01 className="size-3 shrink-0" />
              <span>{t("chat.assistant.resumedBackgroundTask")}</span>
            </div>
          )}
          {collapsed.length > 0 && (
            <CollapsedSection
              items={collapsed}
              message={message!}
              reasoningGroups={reasoningGroups}
              isReasoningActive={isReasoningActive}
              totalDuration={totalDuration}
              dataParts={dataParts}
              isLoading={isLoading}
              isLast={isLast}
            />
          )}
          {tail.map((item, idx) => {
            const globalIndex = collapsed.length + idx;
            const isLastPart =
              tail.findLastIndex((r) => r.kind === "part") === idx;
            return renderItem({
              item,
              renderIndex: globalIndex,
              message: message!,
              reasoningGroups,
              isReasoningActive,
              totalDuration,
              dataParts,
              isLoading,
              isLast,
              isLastVisiblePart: isLastPart,
              renderOrder,
            });
          })}
          {taskId && (
            <MessageProducedFiles threadId={taskId} message={message!} />
          )}
          {isLast && isLoading && startedAt !== null && (
            <GeneratingFooter startedAt={startedAt} />
          )}
          {isLast && !isLoading && taskId && (
            <>
              <ThreadHtmlPreviews />
              {isTerminallyDone && <NextActionChip />}
            </>
          )}
          {!isLoading && <MessageTimestamp message={message!} />}
        </div>
      ) : isLoading ? (
        <ThinkingState startedAt={startedAt} />
      ) : (
        <EmptyAssistantState isRunInProgress={isLast && isRunInProgress} />
      )}
    </Container>
  );
}

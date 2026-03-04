import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertCircle,
  CheckCircle,
  ChevronLeft,
  Loading01,
  XCircle,
  XClose,
} from "@untitledui/icons";
import { calculateUsageStats } from "@/web/lib/usage-utils";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { useChat } from "./context";
import type { ChatMessage, SubtaskToolPart } from "./types";
import { useState } from "react";

// ============================================================================
// Helpers
// ============================================================================

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

function formatDate(d: string | Date | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatModelId(id: string | undefined): string {
  if (!id) return "—";
  const stripped = id.replace(/-\d{8}(?:-[a-z0-9]+)*$/i, "");
  return stripped.replace(/-/g, " ");
}

// ============================================================================
// StatGrid
// ============================================================================

interface StatItem {
  label: string;
  value: string | number;
}

function StatGrid({ items }: { items: StatItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-6">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-1 min-w-0">
          <span className="text-xs text-muted-foreground truncate">
            {item.label}
          </span>
          <span className="text-sm text-foreground tabular-nums truncate">
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// ContextBreakdownBar
// ============================================================================

function ContextBreakdownBar({
  userTokens,
  assistantTokens,
  otherTokens,
}: {
  userTokens: number;
  assistantTokens: number;
  otherTokens: number;
}) {
  const total = userTokens + assistantTokens + otherTokens;

  const userPct = total > 0 ? (userTokens / total) * 100 : 0;
  const assistantPct = total > 0 ? (assistantTokens / total) * 100 : 0;
  const otherPct = total > 0 ? (otherTokens / total) * 100 : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {userPct > 0 && (
          <div className="h-full bg-chart-1" style={{ width: `${userPct}%` }} />
        )}
        {assistantPct > 0 && (
          <div
            className="h-full bg-chart-2"
            style={{ width: `${assistantPct}%` }}
          />
        )}
        {otherPct > 0 && (
          <div
            className="h-full bg-muted-foreground/30"
            style={{ width: `${otherPct}%` }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-chart-1 shrink-0" />
          <span className="text-xs text-muted-foreground">
            User {userPct.toFixed(1)}%
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-chart-2 shrink-0" />
          <span className="text-xs text-muted-foreground">
            Assistant {assistantPct.toFixed(1)}%
          </span>
        </div>
        {otherTokens > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/30 shrink-0" />
            <span className="text-xs text-muted-foreground">
              Other {otherPct.toFixed(1)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// ChatContextPanel
// ============================================================================

interface ChatContextPanelProps {
  onClose: () => void;
  /** Show a back chevron instead of X — use when embedded in a slide panel */
  back?: boolean;
  className?: string;
}

export function ChatContextPanel({
  onClose,
  back,
  className,
}: ChatContextPanelProps) {
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(
    null,
  );

  const {
    messages,
    tasks,
    activeTaskId,
    selectedModel,
    selectedVirtualMcp,
    virtualMcps,
  } = useChat();

  const activeTask = tasks.find((t) => t.id === activeTaskId);

  const stats = calculateUsageStats(
    messages as Array<{
      metadata?: {
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          reasoningTokens?: number;
          totalTokens?: number;
        };
      };
    }>,
  );

  const contextWindow = selectedModel?.thinking?.limits?.contextWindow ?? null;

  const usagePct =
    contextWindow && contextWindow > 0
      ? ((stats.totalTokens / contextWindow) * 100).toFixed(1)
      : null;

  // Per-role token breakdown from message metadata
  const userTokens = (messages as ChatMessage[])
    .filter((m) => m.role === "user")
    .reduce((sum, m) => {
      const usage = (
        m.metadata as { usage?: { inputTokens?: number } } | undefined
      )?.usage;
      return sum + (usage?.inputTokens ?? 0);
    }, 0);

  const assistantTokens = (messages as ChatMessage[])
    .filter((m) => m.role === "assistant")
    .reduce((sum, m) => {
      const usage = (
        m.metadata as { usage?: { outputTokens?: number } } | undefined
      )?.usage;
      return sum + (usage?.outputTokens ?? 0);
    }, 0);

  const otherTokens = Math.max(
    0,
    stats.totalTokens - userTokens - assistantTokens,
  );

  // Timestamps
  const firstMessage = (messages as ChatMessage[])[0];
  const lastMessage = (messages as ChatMessage[]).at(-1);

  const sessionCreated =
    firstMessage?.metadata?.created_at ?? activeTask?.created_at;
  const lastActivity =
    lastMessage?.metadata?.created_at ?? activeTask?.updated_at;

  // Non-system messages for the messages list
  const visibleMessages = (messages as ChatMessage[]).filter(
    (m) => m.role !== "system",
  );

  // Subtask parts across all messages
  interface SubtaskEntry {
    part: SubtaskToolPart;
    agentTitle: string;
    agentIcon?: string | null;
    isRunning: boolean;
    isError: boolean;
    isApproval: boolean;
  }
  const subtasks: SubtaskEntry[] = (messages as ChatMessage[]).flatMap((m) =>
    (m.parts ?? [])
      .filter((p): p is SubtaskToolPart => p.type === "tool-subtask")
      .map((part) => {
        const agentId = part.input?.agent_id;
        const agent = agentId
          ? virtualMcps.find((v) => v.id === agentId)
          : null;
        const isRunning =
          part.state === "input-streaming" ||
          part.state === "input-available" ||
          (part.state === "output-available" &&
            (part as { preliminary?: boolean }).preliminary === true);
        const isError = part.state === "output-error";
        const isApproval = part.state === "approval-requested";
        return {
          part,
          agentTitle: agent?.title ?? "Subtask",
          agentIcon: agent?.icon ?? null,
          isRunning,
          isError,
          isApproval,
        };
      }),
  );

  const modelLabel = selectedModel?.thinking?.id
    ? formatModelId(selectedModel.thinking.id)
    : "—";

  const agentTitle = selectedVirtualMcp?.title ?? "Decopilot";

  const allStats: StatItem[] = [
    { label: "Session", value: activeTask?.title ?? "New chat" },
    { label: "Messages", value: visibleMessages.length },
    { label: "Agent", value: agentTitle },
    { label: "Model", value: modelLabel },
    {
      label: "Context Limit",
      value: contextWindow ? formatTokens(contextWindow) : "—",
    },
    {
      label: "Total Tokens",
      value: stats.totalTokens > 0 ? formatTokens(stats.totalTokens) : "0",
    },
    {
      label: "Usage",
      value: usagePct !== null ? `${usagePct}%` : "—",
    },
    {
      label: "Input Tokens",
      value: stats.inputTokens > 0 ? formatTokens(stats.inputTokens) : "0",
    },
    {
      label: "Output Tokens",
      value: stats.outputTokens > 0 ? formatTokens(stats.outputTokens) : "0",
    },
    {
      label: "Reasoning Tokens",
      value:
        stats.reasoningTokens > 0 ? formatTokens(stats.reasoningTokens) : "0",
    },
    {
      label: "Cost",
      value:
        stats.cost > 0
          ? `$${stats.cost < 0.001 ? stats.cost.toFixed(6) : stats.cost.toFixed(4)}`
          : "$0.00",
    },
    { label: "Session Created", value: formatDate(sessionCreated) },
    { label: "Last Activity", value: formatDate(lastActivity) },
  ];

  if (!activeTask && visibleMessages.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col h-full w-full border-l border-border bg-background",
          className,
        )}
      >
        <div className="h-11 px-4 flex items-center justify-between shrink-0 border-b border-border/50">
          <span className="text-sm font-medium text-foreground">Context</span>
          <button
            type="button"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded hover:bg-accent transition-colors"
          >
            {back ? (
              <ChevronLeft size={14} className="text-muted-foreground" />
            ) : (
              <XClose size={14} className="text-muted-foreground" />
            )}
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center px-4 text-center">
          <p className="text-xs text-muted-foreground">
            Start a conversation to see context
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col h-full w-full border-l border-border bg-background overflow-y-auto",
        className,
      )}
    >
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/50 px-4">
        <span className="text-sm font-medium text-foreground">Context</span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {back ? <ChevronLeft size={14} /> : <XClose size={14} />}
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-8 p-6">
        {/* Subtasks / subagents */}
        {subtasks.length > 0 && (
          <div className="flex flex-col gap-3">
            <span className="text-xs text-muted-foreground">Subtasks</span>
            <div className="flex flex-col gap-1">
              {subtasks.map((s, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs min-w-0"
                >
                  <IntegrationIcon
                    icon={s.agentIcon}
                    name={s.agentTitle}
                    size="xs"
                    className="size-6 rounded-md shrink-0"
                  />
                  <span
                    className={cn(
                      "shrink-0 font-medium",
                      s.isError ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {s.agentTitle}
                  </span>
                  {s.part.input?.prompt && (
                    <>
                      <span className="text-muted-foreground/50">·</span>
                      <span className="truncate text-muted-foreground">
                        {s.part.input.prompt}
                      </span>
                    </>
                  )}
                  <span className="ml-auto shrink-0">
                    {s.isRunning ? (
                      <Loading01
                        size={12}
                        className="animate-spin text-muted-foreground"
                      />
                    ) : s.isError ? (
                      <XCircle size={12} className="text-destructive" />
                    ) : s.isApproval ? (
                      <AlertCircle size={12} className="text-warning" />
                    ) : (
                      <CheckCircle size={12} className="text-emerald-500" />
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Flat stats grid */}
        <StatGrid items={allStats} />

        {/* Context Breakdown */}
        <div className="flex flex-col gap-3">
          <span className="text-xs text-muted-foreground">
            Context Breakdown
          </span>
          <ContextBreakdownBar
            userTokens={userTokens}
            assistantTokens={assistantTokens}
            otherTokens={otherTokens}
          />
        </div>

        {/* Raw messages */}
        {visibleMessages.length > 0 && (
          <div className="flex flex-col gap-3">
            <span className="text-xs text-muted-foreground">Raw messages</span>
            <div className="flex flex-col gap-1">
              {visibleMessages.map((m) => {
                const createdAt = (
                  m.metadata as { created_at?: string | Date } | undefined
                )?.created_at;
                const isExpanded = selectedMessage?.id === m.id;
                return (
                  <div
                    key={m.id}
                    className="rounded-md border border-border/50 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedMessage(isExpanded ? null : m)}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-accent/50 w-full text-left cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            "shrink-0 font-medium",
                            m.role === "user" ? "text-chart-1" : "text-chart-2",
                          )}
                        >
                          {m.role}
                        </span>
                        <span className="text-muted-foreground">•</span>
                        <span className="truncate text-muted-foreground font-mono">
                          {m.id}
                        </span>
                      </div>
                      {createdAt && (
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {new Date(createdAt).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                      )}
                    </button>
                    {isExpanded && (
                      <pre className="text-xs font-mono bg-muted px-3 py-2 overflow-auto whitespace-pre-wrap break-all border-t border-border/50 max-h-64">
                        {JSON.stringify(m, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

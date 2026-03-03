import { cn } from "@deco/ui/lib/utils.ts";
import { XClose } from "@untitledui/icons";
import { calculateUsageStats } from "@/web/lib/usage-utils";
import { useChat } from "./context";
import type { ChatMessage } from "./types";

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
  // Strip trailing date suffixes like -20250101 or -20250101-preview
  const stripped = id.replace(/-\d{8}(?:-[a-z0-9]+)*$/i, "");
  // Replace hyphens with spaces
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
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider truncate">
            {item.label}
          </span>
          <span className="text-sm font-medium text-foreground tabular-nums truncate">
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
          <div
            className="h-full bg-blue-500"
            style={{ width: `${userPct}%` }}
          />
        )}
        {assistantPct > 0 && (
          <div
            className="h-full bg-violet-500"
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
          <span className="inline-block h-2 w-2 rounded-sm bg-blue-500 shrink-0" />
          <span className="text-[10px] text-muted-foreground">
            User ({formatTokens(userTokens)})
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-violet-500 shrink-0" />
          <span className="text-[10px] text-muted-foreground">
            Assistant ({formatTokens(assistantTokens)})
          </span>
        </div>
        {otherTokens > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/30 shrink-0" />
            <span className="text-[10px] text-muted-foreground">
              Other ({formatTokens(otherTokens)})
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
  className?: string;
}

export function ChatContextPanel({
  onClose,
  className,
}: ChatContextPanelProps) {
  const {
    messages,
    threads,
    activeThreadId,
    selectedModel,
    selectedVirtualMcp,
  } = useChat();

  const activeThread = threads.find((t) => t.id === activeThreadId);

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
    firstMessage?.metadata?.created_at ?? activeThread?.created_at;
  const lastActivity =
    lastMessage?.metadata?.created_at ?? activeThread?.updated_at;

  // Non-system messages for the messages list
  const visibleMessages = (messages as ChatMessage[]).filter(
    (m) => m.role !== "system",
  );

  const modelLabel = selectedModel?.thinking?.id
    ? formatModelId(selectedModel.thinking.id)
    : "—";

  const agentTitle = selectedVirtualMcp?.title ?? "Decopilot";

  const tokenStats: StatItem[] = [
    {
      label: "Context Limit",
      value: contextWindow ? formatTokens(contextWindow) : "—",
    },
    {
      label: "Total Tokens",
      value: stats.totalTokens > 0 ? formatTokens(stats.totalTokens) : "0",
    },
    {
      label: "Usage %",
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
      label: "Reasoning",
      value:
        stats.reasoningTokens > 0 ? formatTokens(stats.reasoningTokens) : "0",
    },
    {
      label: "Cost",
      value:
        stats.cost > 0
          ? `$${stats.cost < 0.001 ? stats.cost.toFixed(6) : stats.cost.toFixed(4)}`
          : "$0.0000",
    },
  ];

  const sessionStats: StatItem[] = [
    {
      label: "Session Created",
      value: formatDate(sessionCreated),
    },
    {
      label: "Last Activity",
      value: formatDate(lastActivity),
    },
  ];

  const agentModelStats: StatItem[] = [
    {
      label: "Agent",
      value: agentTitle,
    },
    {
      label: "Model",
      value: modelLabel,
    },
  ];

  const sessionInfoStats: StatItem[] = [
    {
      label: "Thread",
      value: activeThread?.title ?? "New chat",
    },
    {
      label: "Messages",
      value: visibleMessages.length,
    },
  ];

  return (
    <div
      className={cn(
        "flex flex-col h-full w-[320px] shrink-0 border-l border-border bg-background overflow-y-auto",
        className,
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold text-foreground">Context</span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XClose size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-5 p-4">
        {/* Session section */}
        <div className="flex flex-col gap-3">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Session
          </span>
          <StatGrid items={sessionInfoStats} />
        </div>

        <div className="h-px bg-border" />

        {/* Agent + Model */}
        <div className="flex flex-col gap-3">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Agent &amp; Model
          </span>
          <StatGrid items={agentModelStats} />
        </div>

        <div className="h-px bg-border" />

        {/* Token metrics */}
        <div className="flex flex-col gap-3">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Token Metrics
          </span>
          <StatGrid items={tokenStats} />
        </div>

        <div className="h-px bg-border" />

        {/* Timestamps */}
        <div className="flex flex-col gap-3">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Timestamps
          </span>
          <StatGrid items={sessionStats} />
        </div>

        <div className="h-px bg-border" />

        {/* Context Breakdown */}
        <div className="flex flex-col gap-3">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Context Breakdown
          </span>
          <ContextBreakdownBar
            userTokens={userTokens}
            assistantTokens={assistantTokens}
            otherTokens={otherTokens}
          />
        </div>

        {visibleMessages.length > 0 && (
          <>
            <div className="h-px bg-border" />

            {/* Messages list */}
            <div className="flex flex-col gap-3">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Messages
              </span>
              <div className="flex flex-col gap-1">
                {visibleMessages.map((m) => {
                  const createdAt = (
                    m.metadata as { created_at?: string | Date } | undefined
                  )?.created_at;
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-accent/50"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                            m.role === "user"
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                              : "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
                          )}
                        >
                          {m.role}
                        </span>
                        <span className="truncate text-muted-foreground font-mono">
                          {m.id.slice(0, 8)}
                        </span>
                      </div>
                      {createdAt && (
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {new Date(createdAt).toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

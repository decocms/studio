import { Page } from "@/web/components/page";
import type { TriggerEntity } from "@/web/components/triggers/trigger-form";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { KEYS } from "@/web/lib/query-keys";
import {
  SELF_MCP_ALIAS_ID,
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
  useMCPClient,
} from "@decocms/mesh-sdk";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Clock,
  Lightning01,
  ArrowRight,
  Loading01,
  Plus,
} from "@untitledui/icons";
import { Suspense } from "react";
import { Cron } from "croner";
import { formatTimeAgo } from "@/web/lib/format-time";
import { toast } from "sonner";

function cronToHuman(expr: string): string {
  try {
    const parts = expr.split(" ");
    if (parts.length < 5) return expr;

    const min = parts[0] ?? "*";
    const hour = parts[1] ?? "*";
    const dayOfMonth = parts[2] ?? "*";
    const month = parts[3] ?? "*";
    const dayOfWeek = parts[4] ?? "*";

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthNames = [
      "",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    if (
      min === "*" &&
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return "Every minute";
    }

    if (min?.startsWith("*/") && hour === "*") {
      return `Every ${min.slice(2)} minutes`;
    }

    if (min !== "*" && hour === "*" && dayOfMonth === "*") {
      return `Every hour at :${min?.padStart(2, "0")}`;
    }

    if (hour?.startsWith("*/")) {
      return `Every ${hour.slice(2)} hours`;
    }

    const timeStr =
      hour !== "*" && min !== "*"
        ? `${hour?.padStart(2, "0")}:${min?.padStart(2, "0")}`
        : null;

    if (dayOfWeek === "1-5" && timeStr) {
      return `Weekdays at ${timeStr}`;
    }

    if (dayOfWeek !== "*" && timeStr) {
      const days = dayOfWeek.split(",").map((d) => dayNames[Number(d)] ?? d);
      return `${days.join(", ")} at ${timeStr}`;
    }

    if (dayOfMonth !== "*" && month === "*" && timeStr) {
      return `Day ${dayOfMonth} of every month at ${timeStr}`;
    }

    if (dayOfMonth !== "*" && month !== "*" && timeStr) {
      return `${monthNames[Number(month)] ?? month} ${dayOfMonth} at ${timeStr}`;
    }

    if (timeStr && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Daily at ${timeStr}`;
    }

    return expr;
  } catch {
    return expr;
  }
}

function getNextRun(expr: string): string | null {
  try {
    const cron = new Cron(expr);
    const next = cron.nextRun();
    if (!next) return null;
    const now = new Date();
    const diff = next.getTime() - now.getTime();
    if (diff < 60000) return "in < 1 min";
    if (diff < 3600000) return `in ${Math.round(diff / 60000)} min`;
    if (diff < 86400000) return `in ${Math.round(diff / 3600000)}h`;
    return next.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function describeAction(trigger: TriggerEntity): string {
  if (trigger.actionType === "tool_call") {
    return `Call ${trigger.toolName ?? "tool"}${trigger.connectionId ? " on connection" : ""}`;
  }
  return "Run agent with prompt";
}

function TriggerCard({
  trigger,
  onToggle,
  isToggling,
  onClick,
}: {
  trigger: TriggerEntity;
  onToggle: () => void;
  isToggling: boolean;
  onClick: () => void;
}) {
  const nextRun =
    trigger.triggerType === "cron" && trigger.cronExpression
      ? getNextRun(trigger.cronExpression)
      : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-xl border border-border bg-card p-4 transition-colors duration-150 hover:bg-accent/50 cursor-pointer"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {trigger.triggerType === "cron" ? (
            <Clock size={16} className="shrink-0 text-muted-foreground" />
          ) : (
            <Lightning01 size={16} className="shrink-0 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground truncate">
            {trigger.triggerType === "cron" && trigger.cronExpression
              ? cronToHuman(trigger.cronExpression)
              : trigger.eventType
                ? `On "${trigger.eventType}" event`
                : "Unknown trigger"}
          </span>
          {trigger.title && (
            <span className="text-xs text-muted-foreground truncate">
              — {trigger.title}
            </span>
          )}
        </div>
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={trigger.enabled}
            onCheckedChange={onToggle}
            disabled={isToggling}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 mt-1.5 ml-[26px]">
        <ArrowRight size={14} className="shrink-0 text-muted-foreground" />
        <span className="text-sm text-muted-foreground truncate">
          {describeAction(trigger)}
        </span>
      </div>

      <div className="flex items-center gap-3 mt-1.5 ml-[26px] text-xs text-muted-foreground">
        {trigger.lastRunAt && (
          <span className="flex items-center gap-1">
            Last run: {formatTimeAgo(new Date(trigger.lastRunAt))}
            {trigger.lastRunStatus === "success" && (
              <span className="text-green-500">&#10003;</span>
            )}
            {trigger.lastRunStatus === "failed" && (
              <span className="text-destructive">&#10007;</span>
            )}
          </span>
        )}
        {nextRun && <span>Next: {nextRun}</span>}
        {!trigger.lastRunAt && !nextRun && <span>Never run</span>}
      </div>
    </button>
  );
}

function TriggersContent() {
  const { org, locator } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.triggers(locator),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "TRIGGER_LIST",
        arguments: {},
      })) as { structuredContent?: { triggers: TriggerEntity[] } };
      return (
        (result.structuredContent as { triggers: TriggerEntity[] }) ?? {
          triggers: [],
        }
      );
    },
  });

  const triggers = data?.triggers ?? [];

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await client.callTool({
        name: "TRIGGER_UPDATE",
        arguments: { id, enabled },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
    },
    onError: (err) => {
      toast.error(`Failed to toggle trigger: ${err.message}`);
      queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const result = await client.callTool({
        name: "TRIGGER_CREATE",
        arguments: {
          triggerType: "cron",
          cronExpression: "0 9 * * *",
          actionType: "tool_call",
        },
      });
      return result;
    },
    onSuccess: (result) => {
      const data = (result as { structuredContent?: TriggerEntity })
        .structuredContent;
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
        navigate({
          to: "/$org/$project/triggers/$triggerId",
          params: {
            org: org.slug,
            project: ORG_ADMIN_PROJECT_SLUG,
            triggerId: data.id,
          },
        });
      }
    },
    onError: (err) => {
      toast.error(`Failed to create trigger: ${err.message}`);
    },
  });

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Triggers</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <Button
            onClick={() => createMutation.mutate()}
            size="sm"
            className="h-7 px-3 rounded-lg text-sm font-medium"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loading01 size={14} className="animate-spin" />
            ) : (
              <Plus size={16} />
            )}
            {createMutation.isPending ? "Creating..." : "New Trigger"}
          </Button>
        </Page.Header.Right>
      </Page.Header>

      <Page.Content>
        <div className="flex-1 overflow-auto p-5">
          {triggers.length === 0 ? (
            <EmptyState
              image={
                <Lightning01 size={36} className="text-muted-foreground" />
              }
              title="No triggers yet"
              description="Create your first automation — schedule recurring actions or react to events."
            />
          ) : (
            <div className="flex flex-col gap-3 max-w-3xl">
              {triggers.map((trigger) => (
                <TriggerCard
                  key={trigger.id}
                  trigger={trigger}
                  onToggle={() =>
                    toggleMutation.mutate({
                      id: trigger.id,
                      enabled: !trigger.enabled,
                    })
                  }
                  isToggling={toggleMutation.isPending}
                  onClick={() =>
                    navigate({
                      to: "/$org/$project/triggers/$triggerId",
                      params: {
                        org: org.slug,
                        project: ORG_ADMIN_PROJECT_SLUG,
                        triggerId: trigger.id,
                      },
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
      </Page.Content>
    </Page>
  );
}

export default function OrgTriggers() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <TriggersContent />
      </Suspense>
    </ErrorBoundary>
  );
}

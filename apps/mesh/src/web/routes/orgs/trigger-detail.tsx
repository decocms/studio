import { Page } from "@/web/components/page";
import {
  TriggerFormFields,
  type FormValues,
  type TriggerEntity,
} from "@/web/components/triggers/trigger-form";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@deco/ui/components/resizable.tsx";
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
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Clock, FlipBackward, Loading01, Save01 } from "@untitledui/icons";
import { Suspense } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Cron } from "croner";
import { formatTimeAgo } from "@/web/lib/format-time";

// ---- Activity Panel ----

interface TriggerRun {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === "in_progress") {
    return <Loading01 size={14} className="animate-spin text-blue-500" />;
  }
  if (status === "completed") {
    return (
      <div className="w-3.5 h-3.5 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[9px] font-bold">
        &#10003;
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="w-3.5 h-3.5 rounded-full bg-destructive flex items-center justify-center text-white text-[9px] font-bold">
        &#10007;
      </div>
    );
  }
  return <div className="w-3.5 h-3.5 rounded-full bg-muted-foreground/30" />;
}

function TriggerActivityPanel({
  trigger,
  triggerId,
}: {
  trigger: TriggerEntity;
  triggerId: string;
}) {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const navigate = useNavigate();

  const runsQuery = useQuery({
    queryKey: KEYS.triggerRuns(locator, triggerId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "TRIGGER_RUNS_LIST",
        arguments: { triggerId, limit: 20 },
      })) as { structuredContent?: { runs: TriggerRun[] } };
      return result.structuredContent?.runs ?? [];
    },
  });

  const runs = runsQuery.data ?? [];

  const nextRun = (() => {
    if (trigger.triggerType !== "cron" || !trigger.cronExpression) return null;
    try {
      const cron = new Cron(trigger.cronExpression);
      return cron.nextRun();
    } catch {
      return null;
    }
  })();

  return (
    <div className="flex flex-col gap-4 h-full p-5">
      <h3 className="text-sm font-semibold text-foreground">Activity</h3>

      {/* Next run (cron only) */}
      {nextRun && (
        <div className="rounded-xl border border-border p-4 flex flex-col gap-1.5 bg-card">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Next run
          </span>
          <p className="text-sm text-foreground">
            {nextRun.toLocaleDateString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
      )}

      {/* Recent runs */}
      {runsQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loading01 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 flex flex-col items-center gap-3 text-muted-foreground bg-muted/20">
          <Clock size={28} className="opacity-40" />
          <div className="text-center">
            <p className="text-sm font-medium">No runs yet</p>
            <p className="text-xs mt-0.5">This trigger hasn't fired yet</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
            Recent runs
          </span>
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() =>
                navigate({
                  to: "/$org/$project/triggers",
                  params: {
                    org: org.slug,
                    project: ORG_ADMIN_PROJECT_SLUG,
                  },
                })
              }
              className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent/50 transition-colors text-left cursor-pointer"
            >
              <RunStatusIcon status={run.status} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{run.title}</p>
                <p className="text-xs text-muted-foreground">
                  {formatTimeAgo(new Date(run.createdAt))}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Detail Content ----

function TriggerDetailContent() {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  const { triggerId } = useParams({ strict: false }) as {
    triggerId: string;
  };
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data: trigger } = useSuspenseQuery({
    queryKey: KEYS.trigger(locator, triggerId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "TRIGGER_GET",
        arguments: { id: triggerId },
      })) as { structuredContent?: TriggerEntity };
      return result.structuredContent as TriggerEntity;
    },
  });

  const form = useForm<FormValues>({
    defaultValues: {
      title: trigger.title ?? "",
      triggerType: trigger.triggerType,
      cronExpression: trigger.cronExpression ?? "",
      eventType: trigger.eventType ?? "",
      eventFilter: trigger.eventFilter ?? "",
      actionType: trigger.actionType,
      connectionId: trigger.connectionId ?? "",
      toolName: trigger.toolName ?? "",
      toolArguments: trigger.toolArguments ?? "",
      agentId: trigger.agentId ?? "",
      agentPrompt: trigger.agentPrompt ?? "",
    },
  });

  const isDirty = form.formState.isDirty;

  const updateMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      await client.callTool({
        name: "TRIGGER_UPDATE",
        arguments: {
          id: triggerId,
          title: values.title || null,
          triggerType: values.triggerType,
          cronExpression:
            values.triggerType === "cron" ? values.cronExpression : null,
          eventType: values.triggerType === "event" ? values.eventType : null,
          eventFilter:
            values.triggerType === "event" && values.eventFilter
              ? values.eventFilter
              : null,
          actionType: values.actionType,
          connectionId:
            values.actionType === "tool_call" ? values.connectionId : null,
          toolName: values.actionType === "tool_call" ? values.toolName : null,
          toolArguments:
            values.actionType === "tool_call" && values.toolArguments
              ? values.toolArguments
              : null,
          agentId: values.actionType === "agent_prompt" ? values.agentId : null,
          agentPrompt:
            values.actionType === "agent_prompt" ? values.agentPrompt : null,
        },
      });
    },
    onSuccess: () => {
      toast.success("Trigger updated");
      form.reset(form.getValues());
      queryClient.invalidateQueries({
        queryKey: KEYS.trigger(locator, triggerId),
      });
      queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
    },
    onError: (err) => {
      toast.error(`Failed to update trigger: ${err.message}`);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await client.callTool({
        name: "TRIGGER_UPDATE",
        arguments: { id: triggerId, enabled },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.trigger(locator, triggerId),
      });
      queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    updateMutation.mutate(values);
  });

  return (
    <Page>
      {/* Header */}
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link
                    to="/$org/$project/triggers"
                    params={{
                      org: org.slug,
                      project: ORG_ADMIN_PROJECT_SLUG,
                    }}
                  >
                    Triggers
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{trigger.title || "Untitled"}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          {isDirty && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => form.reset()}
                disabled={updateMutation.isPending}
              >
                <FlipBackward size={14} />
                Undo
              </Button>
              <Button
                size="sm"
                onClick={onSubmit}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? (
                  <Loading01 size={14} className="animate-spin" />
                ) : (
                  <Save01 size={14} />
                )}
                Save
              </Button>
            </>
          )}
        </Page.Header.Right>
      </Page.Header>

      {/* Content — split layout */}
      <Page.Content>
        <ResizablePanelGroup direction="horizontal" className="h-full">
          {/* Left panel: form */}
          <ResizablePanel defaultSize={55} minSize={35}>
            <div className="h-full overflow-auto">
              <form
                onSubmit={onSubmit}
                className="max-w-xl mx-auto flex flex-col gap-8 pt-10 pb-20 px-6"
              >
                {/* Inline editable title + enable toggle */}
                <div className="flex items-center gap-3">
                  <Input
                    {...form.register("title")}
                    className="h-auto py-0.5 text-lg! font-medium leading-7 px-1 -mx-1 border-transparent hover:bg-input/25 focus:border-input bg-transparent transition-all placeholder:text-muted-foreground/40 placeholder:font-normal flex-1 min-w-0"
                    placeholder="Untitled trigger"
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={trigger.enabled}
                      onCheckedChange={(checked) =>
                        toggleMutation.mutate(checked)
                      }
                      disabled={toggleMutation.isPending}
                    />
                    <span className="text-sm text-muted-foreground">
                      {trigger.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </div>

                <TriggerFormFields form={form} />
              </form>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Right panel: activity */}
          <ResizablePanel defaultSize={45} minSize={25}>
            <div className="h-full overflow-auto border-l border-border/50">
              <TriggerActivityPanel trigger={trigger} triggerId={triggerId} />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </Page.Content>
    </Page>
  );
}

export default function TriggerDetail() {
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
        <TriggerDetailContent />
      </Suspense>
    </ErrorBoundary>
  );
}

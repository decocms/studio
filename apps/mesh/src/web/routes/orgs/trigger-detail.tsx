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
import { Label } from "@deco/ui/components/label.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@deco/ui/components/resizable.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
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
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Clock,
  FlipBackward,
  Loading01,
  Save01,
  Trash01,
} from "@untitledui/icons";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Cron } from "croner";
import { formatTimeAgo } from "@/web/lib/format-time";

// ---- Activity Panel ----

function TriggerActivityPanel({ trigger }: { trigger: TriggerEntity }) {
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
    <div className="flex flex-col gap-4 h-full p-5 max-w-md mx-auto">
      <h3 className="text-sm font-semibold text-foreground">Activity</h3>

      {/* Last run */}
      {trigger.lastRunAt ? (
        <div className="rounded-xl border border-border p-4 flex flex-col gap-2.5 bg-card">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Last run
            </span>
            <Badge
              variant={
                trigger.lastRunStatus === "success" ? "success" : "destructive"
              }
            >
              {trigger.lastRunStatus === "success" ? "Success" : "Failed"}
            </Badge>
          </div>
          <p className="text-sm text-foreground">
            {formatTimeAgo(new Date(trigger.lastRunAt))}
          </p>
          {trigger.lastRunError && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2">
              <p className="text-xs text-destructive">{trigger.lastRunError}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-6 flex flex-col items-center gap-3 text-muted-foreground bg-muted/20">
          <Clock size={28} className="opacity-40" />
          <div className="text-center">
            <p className="text-sm font-medium">No runs yet</p>
            <p className="text-xs mt-0.5">This trigger hasn't fired yet</p>
          </div>
        </div>
      )}

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

      {/* Placeholder */}
      <div className="rounded-xl border border-dashed border-border p-4 flex items-center justify-center text-xs text-muted-foreground mt-auto bg-muted/10">
        Run history coming soon
      </div>
    </div>
  );
}

// ---- Detail Content ----

function TriggerDetailContent() {
  const { org, locator } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { triggerId } = useParams({ strict: false }) as {
    triggerId: string;
  };
  const [deleteOpen, setDeleteOpen] = useState(false);

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

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "TRIGGER_DELETE",
        arguments: { id: triggerId },
      });
    },
    onSuccess: () => {
      toast.success("Trigger deleted");
      queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
      navigate({
        to: "/$org/$project/triggers",
        params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
      });
    },
    onError: (err) => {
      toast.error(`Failed to delete trigger: ${err.message}`);
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
      {/* Delete Confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Trigger?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this
              trigger.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
          <div className="flex items-center gap-2">
            <Switch
              checked={trigger.enabled}
              onCheckedChange={(checked) => toggleMutation.mutate(checked)}
              disabled={toggleMutation.isPending}
            />
            <span className="text-sm text-muted-foreground">
              {trigger.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash01 size={14} />
            Delete
          </Button>
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
            <div className="h-full overflow-auto p-5">
              <form
                onSubmit={onSubmit}
                className="max-w-2xl flex flex-col gap-5"
              >
                {/* Name */}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="title">Name</Label>
                  <Input
                    id="title"
                    placeholder="e.g., Daily email summary"
                    {...form.register("title")}
                  />
                </div>

                <TriggerFormFields form={form} />
              </form>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Right panel: activity */}
          <ResizablePanel defaultSize={45} minSize={25}>
            <div className="h-full overflow-auto border-l border-border">
              <TriggerActivityPanel trigger={trigger} />
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

/**
 * Automation Detail Page
 *
 * Settings and trigger management for a single automation.
 * Uses ViewLayout with tabs for Settings and Run History.
 */

import { EmptyState } from "@/web/components/empty-state.tsx";
import { ViewActions, ViewLayout } from "@/web/components/details/layout";
import { SaveActions } from "@/web/components/save-actions";
import {
  useAutomationDetail,
  useAutomationUpdate,
  useAutomationDelete,
  useAutomationTriggerAdd,
  useAutomationTriggerRemove,
  type AutomationTrigger,
} from "@/web/hooks/use-automations";
import { useBindingConnections } from "@/web/hooks/use-binding";
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
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { Tabs, TabsList, TabsTrigger } from "@deco/ui/components/tabs.tsx";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useConnections,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { Loading01, Plus, Trash01 } from "@untitledui/icons";
import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";

// ============================================================================
// Types
// ============================================================================

interface SettingsFormData {
  name: string;
  active: boolean;
  agent_id: string;
  agent_mode: string;
  model_connection_id: string;
  model_id: string;
  temperature: number;
  tool_approval_level: string;
}

// ============================================================================
// Add Trigger Dialog
// ============================================================================

function AddTriggerDialog({
  open,
  onOpenChange,
  automationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  automationId: string;
}) {
  const addTrigger = useAutomationTriggerAdd();
  const connections = useConnections();
  const triggerConnections = useBindingConnections({
    connections,
    binding: "TRIGGER",
  });

  const [triggerType, setTriggerType] = useState<"cron" | "event">("cron");
  const [cronExpression, setCronExpression] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [eventType, setEventType] = useState("");

  const handleSubmit = async () => {
    try {
      const input: Record<string, unknown> = {
        automation_id: automationId,
        type: triggerType,
      };

      if (triggerType === "cron") {
        if (!cronExpression.trim()) {
          toast.error("Cron expression is required");
          return;
        }
        input.cron_expression = cronExpression.trim();
      } else {
        if (!connectionId) {
          toast.error("Connection is required for event triggers");
          return;
        }
        if (!eventType.trim()) {
          toast.error("Event type is required");
          return;
        }
        input.connection_id = connectionId;
        input.event_type = eventType.trim();
      }

      await addTrigger.mutateAsync(input);
      toast.success("Trigger added");
      onOpenChange(false);
      // Reset form
      setCronExpression("");
      setConnectionId("");
      setEventType("");
      setTriggerType("cron");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add trigger";
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Trigger</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-2">
            <Label>Type</Label>
            <Select
              value={triggerType}
              onValueChange={(v) => setTriggerType(v as "cron" | "event")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">Cron (Scheduled)</SelectItem>
                <SelectItem value="event">Event (Connection-based)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {triggerType === "cron" ? (
            <div className="flex flex-col gap-2">
              <Label>Cron Expression</Label>
              <Input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="*/5 * * * *"
              />
              <p className="text-xs text-muted-foreground">
                Minimum interval: 60 seconds between runs.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label>Connection</Label>
                <Select value={connectionId} onValueChange={setConnectionId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select connection..." />
                  </SelectTrigger>
                  <SelectContent>
                    {triggerConnections.map((conn) => (
                      <SelectItem key={conn.id} value={conn.id}>
                        {conn.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {triggerConnections.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No connections implement the TRIGGER binding.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <Label>Event Type</Label>
                <Input
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  placeholder="e.g. webhook.received"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={addTrigger.isPending}>
            {addTrigger.isPending && (
              <Loading01 size={14} className="animate-spin" />
            )}
            Add Trigger
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Trigger Row
// ============================================================================

function TriggerRow({
  trigger,
  automationId,
}: {
  trigger: AutomationTrigger;
  automationId: string;
}) {
  const removeTrigger = useAutomationTriggerRemove();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleRemove = async () => {
    try {
      await removeTrigger.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
      toast.success("Trigger removed");
    } catch {
      toast.error("Failed to remove trigger");
    }
    setConfirmDelete(false);
  };

  return (
    <>
      <TableRow>
        <TableCell>
          <Badge variant="outline">
            {trigger.type === "cron" ? "Cron" : "Event"}
          </Badge>
        </TableCell>
        <TableCell className="text-muted-foreground font-mono text-xs">
          {trigger.type === "cron"
            ? trigger.cron_expression
            : `${trigger.event_type} @ ${trigger.connection_id?.slice(0, 8)}...`}
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">
          {trigger.next_run_at
            ? new Date(trigger.next_run_at).toLocaleString()
            : "-"}
        </TableCell>
        <TableCell>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash01 size={14} className="text-muted-foreground" />
          </Button>
        </TableCell>
      </TableRow>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Trigger</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this trigger? For event triggers,
              it will also be disabled on the connection.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ============================================================================
// Settings Tab
// ============================================================================

function SettingsTab({
  automationId,
  automation,
}: {
  automationId: string;
  automation: NonNullable<ReturnType<typeof useAutomationDetail>["data"]>;
}) {
  const updateMutation = useAutomationUpdate();
  const virtualMcps = useVirtualMCPs();
  const connections = useConnections();
  const modelConnections = useBindingConnections({
    connections,
    binding: "LLMS",
  });

  const [addTriggerOpen, setAddTriggerOpen] = useState(false);

  const form = useForm<SettingsFormData>({
    defaultValues: {
      name: automation.name,
      active: automation.active,
      agent_id: automation.agent?.id ?? "",
      agent_mode: automation.agent?.mode ?? "passthrough",
      model_connection_id: automation.models?.connectionId ?? "",
      model_id: automation.models?.thinking?.id ?? "",
      temperature: automation.temperature,
      tool_approval_level: automation.tool_approval_level,
    },
  });

  const handleSave = async () => {
    const values = form.getValues();
    try {
      await updateMutation.mutateAsync({
        id: automationId,
        name: values.name,
        active: values.active,
        agent: {
          id: values.agent_id,
          mode: values.agent_mode,
        },
        models: {
          connectionId: values.model_connection_id,
          thinking: { id: values.model_id },
        },
        temperature: values.temperature,
        tool_approval_level: values.tool_approval_level,
      });
      form.reset(values);
      toast.success("Automation saved");
    } catch {
      toast.error("Failed to save automation");
    }
  };

  const handleUndo = () => {
    form.reset();
  };

  return (
    <>
      <ViewActions>
        <SaveActions
          onSave={handleSave}
          onUndo={handleUndo}
          isDirty={form.formState.isDirty}
          isSaving={updateMutation.isPending}
        />
      </ViewActions>

      <div className="flex flex-col gap-6 p-6 max-w-2xl">
        {/* Name & Active */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2 flex-1">
            <Label>Name</Label>
            <Input {...form.register("name")} placeholder="Automation name" />
          </div>
          <div className="flex flex-col gap-2 items-center pt-6">
            <Controller
              control={form.control}
              name="active"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <span className="text-xs text-muted-foreground">
              {form.watch("active") ? "Active" : "Inactive"}
            </span>
          </div>
        </div>

        {/* Agent */}
        <div className="flex flex-col gap-2">
          <Label>Agent</Label>
          <Controller
            control={form.control}
            name="agent_id"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select agent..." />
                </SelectTrigger>
                <SelectContent>
                  {virtualMcps.map((vmcp) => (
                    <SelectItem key={vmcp.id} value={vmcp.id}>
                      {vmcp.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

        {/* Agent Mode */}
        <div className="flex flex-col gap-2">
          <Label>Agent Mode</Label>
          <Controller
            control={form.control}
            name="agent_mode"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="passthrough">Passthrough</SelectItem>
                  <SelectItem value="smart_tool_selection">
                    Smart Tool Selection
                  </SelectItem>
                  <SelectItem value="code_execution">Code Execution</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        {/* Model Connection */}
        <div className="flex flex-col gap-2">
          <Label>Model Connection</Label>
          <Controller
            control={form.control}
            name="model_connection_id"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select model connection..." />
                </SelectTrigger>
                <SelectContent>
                  {modelConnections.map((conn) => (
                    <SelectItem key={conn.id} value={conn.id}>
                      {conn.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

        {/* Model ID */}
        <div className="flex flex-col gap-2">
          <Label>Model ID</Label>
          <Input
            {...form.register("model_id")}
            placeholder="e.g. claude-sonnet-4-20250514"
          />
        </div>

        {/* Temperature */}
        <div className="flex flex-col gap-2">
          <Label>Temperature</Label>
          <Input
            {...form.register("temperature", { valueAsNumber: true })}
            type="number"
            min={0}
            max={2}
            step={0.1}
          />
        </div>

        {/* Tool Approval Level */}
        <div className="flex flex-col gap-2">
          <Label>Tool Approval Level</Label>
          <Controller
            control={form.control}
            name="tool_approval_level"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="readonly">Read Only</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        {/* Triggers Section */}
        <div className="flex flex-col gap-3 border-t border-border pt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Triggers</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddTriggerOpen(true)}
            >
              <Plus size={14} />
              Add Trigger
            </Button>
          </div>

          {automation.triggers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No triggers configured. Add a cron schedule or event trigger.
            </p>
          ) : (
            <UITable>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Configuration</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {automation.triggers.map((trigger) => (
                  <TriggerRow
                    key={trigger.id}
                    trigger={trigger}
                    automationId={automationId}
                  />
                ))}
              </TableBody>
            </UITable>
          )}
        </div>
      </div>

      <AddTriggerDialog
        open={addTriggerOpen}
        onOpenChange={setAddTriggerOpen}
        automationId={automationId}
      />
    </>
  );
}

// ============================================================================
// Run History Tab
// ============================================================================

function RunHistoryTab(_props: { automationId: string }) {
  return (
    <div className="h-full flex items-center">
      <EmptyState
        title="No run history"
        description="Run history will appear here when the automation has been triggered."
      />
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function AutomationDetailPage() {
  const { automationId } = useParams({ strict: false }) as {
    automationId: string;
  };
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const { data: automation, isLoading } = useAutomationDetail(automationId);
  const deleteMutation = useAutomationDelete();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const activeTab = search.tab ?? "settings";

  const handleTabChange = (tab: string) => {
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, tab }),
      replace: true,
    } as Parameters<typeof navigate>[0]);
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(automationId);
      toast.success("Automation deleted");
      navigate({
        to: "/$org/$project/automations",
        params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
      });
    } catch {
      toast.error("Failed to delete automation");
    }
    setConfirmDelete(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loading01 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!automation) {
    return (
      <EmptyState
        title="Automation not found"
        description="This automation may have been deleted."
      />
    );
  }

  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to="/$org/$project/automations"
              params={{ org: org.slug, project: ORG_ADMIN_PROJECT_SLUG }}
            >
              Automations
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{automation.name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <ViewActions>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="history">Run History</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-destructive hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash01 size={14} />
          Delete
        </Button>
      </ViewActions>

      {activeTab === "settings" ? (
        <SettingsTab automationId={automationId} automation={automation} />
      ) : (
        <RunHistoryTab automationId={automationId} />
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Automation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{automation.name}&quot;?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ViewLayout>
  );
}

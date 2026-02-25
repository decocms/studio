import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { CronScheduleSelector } from "./cron-schedule-selector";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  isDecopilot,
  useConnections,
  useMCPClientOptional,
  useMCPToolsListQuery,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import {
  Check,
  ChevronSelectorVertical,
  Loading01,
  SearchMd,
  Users03,
} from "@untitledui/icons";
import { Suspense, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Cron } from "croner";

// ---- Shared types ----

export interface TriggerEntity {
  id: string;
  organizationId: string;
  title: string | null;
  enabled: boolean;
  triggerType: "cron" | "event";
  cronExpression: string | null;
  eventType: string | null;
  eventFilter: string | null;
  actionType: "tool_call" | "agent_prompt";
  connectionId: string | null;
  toolName: string | null;
  toolArguments: string | null;
  agentId: string | null;
  agentPrompt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export type TriggerType = "cron" | "event";
export type ActionType = "tool_call" | "agent_prompt";

export interface FormValues {
  title: string;
  triggerType: TriggerType;
  cronExpression: string;
  eventType: string;
  eventFilter: string;
  actionType: ActionType;
  connectionId: string;
  toolName: string;
  toolArguments: string;
  agentId: string;
  agentPrompt: string;
}

const SET_OPTS = { shouldDirty: true } as const;

// ---- PillToggle ----

export function PillToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex self-start rounded-lg bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-150",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---- CronPreview ----

export function CronPreview({ expression }: { expression: string }) {
  if (!expression.trim()) return null;

  try {
    const cron = new Cron(expression);
    const next = cron.nextRun();
    if (!next) return null;

    return (
      <p className="text-xs text-muted-foreground">
        Next:{" "}
        {next.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>
    );
  } catch {
    return <p className="text-xs text-destructive">Invalid cron expression</p>;
  }
}

// ---- ConnectionSelector (rich, with icons) ----

export function ConnectionSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const connections = useConnections();
  const selected = connections.find((c) => c.id === value);

  return (
    <Select
      value={value || "none"}
      onValueChange={(v) => onChange(v === "none" ? "" : v)}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select a connection...">
          {selected ? (
            <div className="flex items-center gap-2">
              {selected.icon ? (
                <img
                  src={selected.icon}
                  alt={selected.title}
                  className="w-4 h-4 rounded shrink-0"
                />
              ) : (
                <div className="w-4 h-4 rounded bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-[10px] font-semibold text-primary shrink-0">
                  {selected.title.slice(0, 1).toUpperCase()}
                </div>
              )}
              <span className="truncate">{selected.title}</span>
            </div>
          ) : (
            "Select a connection..."
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No connection</SelectItem>
        {connections.map((connection) => (
          <SelectItem key={connection.id} value={connection.id}>
            <div className="flex items-center gap-2">
              {connection.icon ? (
                <img
                  src={connection.icon}
                  alt={connection.title}
                  className="w-4 h-4 rounded"
                />
              ) : (
                <div className="w-4 h-4 rounded bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-[10px] font-semibold text-primary">
                  {connection.title.slice(0, 1).toUpperCase()}
                </div>
              )}
              <span>{connection.title}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---- ToolSelector (with loading state) ----

export function ToolSelector({
  connectionId,
  value,
  onChange,
}: {
  connectionId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { org } = useProjectContext();
  const client = useMCPClientOptional({
    connectionId: connectionId || undefined,
    orgId: org.id,
  });

  const toolsQuery = useMCPToolsListQuery({
    client: client!,
    enabled: client !== null,
  });

  const tools = toolsQuery.data?.tools ?? [];
  const selected = tools.find((t) => t.name === value);

  if (toolsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 h-9 rounded-md border border-input px-3 text-sm text-muted-foreground">
        <Loading01 size={14} className="animate-spin" />
        Loading tools...
      </div>
    );
  }

  return (
    <Select
      value={value || "none"}
      onValueChange={(v) => onChange(v === "none" ? "" : v)}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select a tool...">
          {selected
            ? (selected.annotations?.title ?? selected.name)
            : "Select a tool..."}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No tool</SelectItem>
        {tools.map((tool) => (
          <SelectItem key={tool.name} value={tool.name}>
            <div className="flex flex-col gap-0.5">
              <span>{tool.annotations?.title ?? tool.name}</span>
              {tool.description && (
                <span className="text-xs text-muted-foreground line-clamp-1">
                  {tool.description}
                </span>
              )}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---- AgentSelector (searchable Popover grid) ----

export function AgentSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const virtualMcps = useVirtualMCPs();
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const agents = virtualMcps.filter((v) => !v.id || !isDecopilot(v.id));

  const filtered = searchTerm.trim()
    ? agents.filter((a) => {
        const s = searchTerm.toLowerCase();
        return (
          a.title.toLowerCase().includes(s) ||
          a.description?.toLowerCase().includes(s)
        );
      })
    : agents;

  const selected = agents.find((a) => a.id === value);

  const handleSelect = (agentId: string) => {
    onChange(agentId);
    setOpen(false);
    setSearchTerm("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setTimeout(() => searchInputRef.current?.focus(), 0);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm",
            "hover:bg-accent/50 transition-colors text-left",
            !selected && "text-muted-foreground",
          )}
        >
          {selected ? (
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <IntegrationIcon
                icon={selected.icon}
                name={selected.title}
                size="2xs"
                fallbackIcon={<Users03 size={10} />}
                className="rounded shrink-0"
              />
              <span className="truncate">{selected.title}</span>
            </div>
          ) : (
            <span className="flex-1">Select an agent...</span>
          )}
          <ChevronSelectorVertical
            size={16}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[480px] p-0 overflow-hidden" align="start">
        <div className="flex flex-col max-h-[400px]">
          <div className="border-b px-4 py-3 bg-background/95 backdrop-blur sticky top-0 z-10">
            <div className="relative flex items-center gap-2">
              <SearchMd
                size={16}
                className="text-muted-foreground pointer-events-none shrink-0"
              />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search agents..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="flex-1 h-8 text-sm bg-transparent border-0 outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="overflow-y-auto p-1.5">
            {filtered.length > 0 ? (
              <div className="grid grid-cols-2 gap-0.5">
                {filtered.map((agent) => (
                  <div
                    key={agent.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelect(agent.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelect(agent.id);
                      }
                    }}
                    className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl"
                  >
                    <div
                      className={cn(
                        "flex items-start gap-3 py-3 px-3 hover:bg-accent cursor-pointer rounded-xl transition-colors",
                        agent.id === value && "bg-accent",
                      )}
                    >
                      <IntegrationIcon
                        icon={agent.icon}
                        name={agent.title}
                        size="sm"
                        fallbackIcon={<Users03 />}
                        className="rounded-xl border border-border shadow-sm shrink-0 aspect-square"
                      />
                      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-foreground truncate">
                            {agent.title}
                          </span>
                          {agent.id === value && (
                            <Check
                              size={16}
                              className="text-foreground shrink-0"
                            />
                          )}
                        </div>
                        {agent.description && (
                          <p className="text-xs text-muted-foreground line-clamp-1 leading-relaxed">
                            {agent.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                No agents found
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---- SelectorFallback ----

export function SelectorFallback() {
  return (
    <div className="flex items-center gap-2 h-9 rounded-md border border-input px-3 text-sm text-muted-foreground">
      <Loading01 size={14} className="animate-spin" />
      Loading...
    </div>
  );
}

// ---- TriggerFormFields ----

export function TriggerFormFields({
  form,
}: {
  form: UseFormReturn<FormValues>;
}) {
  const triggerType = form.watch("triggerType");
  const actionType = form.watch("actionType");
  const cronExpression = form.watch("cronExpression");
  const connectionId = form.watch("connectionId");

  return (
    <div className="flex flex-col gap-6">
      {/* When section */}
      <div className="flex flex-col gap-4">
        <Label className="text-sm font-semibold text-foreground">When</Label>
        <PillToggle
          value={triggerType}
          onChange={(v) => form.setValue("triggerType", v, SET_OPTS)}
          options={[
            { value: "cron", label: "Schedule" },
            { value: "event", label: "Event" },
          ]}
        />

        {triggerType === "cron" && (
          <div className="flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-150">
            <CronScheduleSelector
              value={cronExpression}
              onChange={(v) => form.setValue("cronExpression", v, SET_OPTS)}
            />
            <CronPreview expression={cronExpression} />
          </div>
        )}

        {triggerType === "event" && (
          <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eventType">Event type</Label>
              <Input
                id="eventType"
                placeholder="e.g., order.created"
                {...form.register("eventType")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eventFilter">Filter (optional)</Label>
              <Input
                id="eventFilter"
                placeholder="JSONPath filter on event data"
                {...form.register("eventFilter")}
              />
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border" />

      {/* Then section */}
      <div className="flex flex-col gap-4">
        <Label className="text-sm font-semibold text-foreground">Then</Label>
        <PillToggle
          value={actionType}
          onChange={(v) => form.setValue("actionType", v, SET_OPTS)}
          options={[
            { value: "tool_call", label: "Call a Tool" },
            { value: "agent_prompt", label: "Run an Agent" },
          ]}
        />

        {actionType === "tool_call" && (
          <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex flex-col gap-1.5">
              <Label>Connection</Label>
              <Suspense fallback={<SelectorFallback />}>
                <ConnectionSelector
                  value={connectionId}
                  onChange={(v) => {
                    form.setValue("connectionId", v, SET_OPTS);
                    form.setValue("toolName", "", SET_OPTS);
                  }}
                />
              </Suspense>
            </div>
            {connectionId && (
              <div className="flex flex-col gap-1.5 animate-in fade-in duration-150">
                <Label>Tool</Label>
                <Suspense fallback={<SelectorFallback />}>
                  <ToolSelector
                    connectionId={connectionId}
                    value={form.watch("toolName")}
                    onChange={(v) => form.setValue("toolName", v, SET_OPTS)}
                  />
                </Suspense>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="toolArguments">Arguments (optional JSON)</Label>
              <Textarea
                id="toolArguments"
                placeholder='{"channel": "#general", "message": "Hello"}'
                rows={3}
                className="font-mono text-xs"
                {...form.register("toolArguments")}
              />
            </div>
          </div>
        )}

        {actionType === "agent_prompt" && (
          <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex flex-col gap-1.5">
              <Label>Agent</Label>
              <Suspense fallback={<SelectorFallback />}>
                <AgentSelector
                  value={form.watch("agentId")}
                  onChange={(v) => form.setValue("agentId", v, SET_OPTS)}
                />
              </Suspense>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agentPrompt">Prompt</Label>
              <Textarea
                id="agentPrompt"
                placeholder="Check the latest emails and summarize for the team"
                rows={3}
                {...form.register("agentPrompt")}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

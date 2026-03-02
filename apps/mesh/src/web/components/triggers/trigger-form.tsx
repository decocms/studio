import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { CronScheduleSelector } from "./cron-schedule-selector";
import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { isDecopilot, useConnections, useVirtualMCPs } from "@decocms/mesh-sdk";
import {
  Check,
  ChevronSelectorVertical,
  Loading01,
  SearchMd,
  Users03,
} from "@untitledui/icons";
import { Suspense, useRef, useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
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
    <div className="inline-flex self-start rounded-lg bg-muted/50 p-0.5 gap-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-[13px] font-medium transition-all duration-150",
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

// ---- EventSourceList ----

function EventSourceList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (connectionId: string) => void;
}) {
  const connections = useConnections();

  if (connections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2">
        No connections available
      </p>
    );
  }

  return (
    <div className="flex flex-col rounded-lg border border-border/60 overflow-hidden divide-y divide-border/30 max-h-[240px] overflow-y-auto">
      {connections.map((conn) => (
        <button
          key={conn.id}
          type="button"
          onClick={() => onSelect(conn.id)}
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 text-sm transition-colors text-left shrink-0",
            selectedId === conn.id ? "bg-accent/60" : "hover:bg-accent/30",
          )}
        >
          <IntegrationIcon
            icon={conn.icon}
            name={conn.title}
            size="xs"
            className="shrink-0"
          />
          <span className="text-foreground">{conn.title}</span>
        </button>
      ))}
    </div>
  );
}

// ---- ToolCombobox ----

function ToolComboboxContent({
  value,
  connectionId,
  onChange,
}: {
  value: string;
  connectionId: string;
  onChange: (toolName: string, connId: string) => void;
}) {
  const connections = useConnections();
  const [open, setOpen] = useState(false);

  // Build tool groups from connections that have tools
  const groups = connections
    .filter((c) => c.tools && c.tools.length > 0)
    .map((c) => ({
      connection: c,
      tools: c.tools!,
    }));

  // Find selected tool info
  const selectedConnection = connections.find((c) => c.id === connectionId);
  const selectedTool = selectedConnection?.tools?.find((t) => t.name === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-3 w-full rounded-lg border border-input/60 px-3 py-2.5 text-sm",
            "hover:border-input hover:bg-accent/30 transition-all text-left cursor-pointer",
            !selectedTool && "text-muted-foreground",
          )}
        >
          {selectedTool ? (
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <IntegrationIcon
                icon={selectedConnection?.icon}
                name={selectedConnection?.title ?? ""}
                size="2xs"
                className="shrink-0"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm text-foreground truncate">
                  {selectedTool.annotations?.title ?? selectedTool.name}
                </span>
                {selectedTool.description && (
                  <span className="text-xs text-muted-foreground truncate">
                    {selectedTool.description}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-1">
              <SearchMd size={16} className="shrink-0 opacity-40" />
              <span>Search for a tool...</span>
            </div>
          )}
          <ChevronSelectorVertical size={16} className="shrink-0 opacity-40" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[480px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tools across all connections..." />
          <CommandList className="max-h-[350px]">
            <CommandEmpty>No tools found</CommandEmpty>
            {groups.map(({ connection, tools }) => (
              <CommandGroup
                key={connection.id}
                heading={
                  <div className="flex items-center gap-2">
                    <IntegrationIcon
                      icon={connection.icon}
                      name={connection.title}
                      size="2xs"
                      className="shrink-0"
                    />
                    <span>{connection.title}</span>
                  </div>
                }
              >
                {tools.map((tool) => {
                  const isSelected =
                    value === tool.name && connectionId === connection.id;
                  return (
                    <CommandItem
                      key={`${connection.id}:${tool.name}`}
                      value={`${connection.title} ${tool.annotations?.title ?? tool.name} ${tool.description ?? ""}`}
                      onSelect={() => {
                        onChange(tool.name, connection.id);
                        setOpen(false);
                      }}
                      className="py-2"
                    >
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="text-sm">
                          {tool.annotations?.title ?? tool.name}
                        </span>
                        {tool.description && (
                          <span className="text-xs text-muted-foreground line-clamp-1">
                            {tool.description}
                          </span>
                        )}
                      </div>
                      {isSelected && (
                        <Check size={16} className="shrink-0 text-foreground" />
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---- AgentSelector ----

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
            "flex items-center gap-3 w-full rounded-lg border border-input/60 px-3 py-2.5 text-sm",
            "hover:border-input hover:bg-accent/30 transition-all text-left cursor-pointer",
            !selected && "text-muted-foreground",
          )}
        >
          {selected ? (
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <IntegrationIcon
                icon={selected.icon}
                name={selected.title}
                size="2xs"
                fallbackIcon={<Users03 size={10} />}
                className="rounded shrink-0"
              />
              <span className="text-foreground truncate">{selected.title}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-1">
              <SearchMd size={16} className="shrink-0 opacity-40" />
              <span>Select an agent...</span>
            </div>
          )}
          <ChevronSelectorVertical size={16} className="shrink-0 opacity-40" />
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
    <div className="flex items-center gap-2 h-9 rounded-lg border border-input/60 px-3 text-sm text-muted-foreground">
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
  const triggerType = useWatch({ control: form.control, name: "triggerType" });
  const actionType = useWatch({ control: form.control, name: "actionType" });
  const cronExpression = useWatch({
    control: form.control,
    name: "cronExpression",
  });
  const connectionId = useWatch({
    control: form.control,
    name: "connectionId",
  });
  const toolName = useWatch({ control: form.control, name: "toolName" });
  const agentId = useWatch({ control: form.control, name: "agentId" });

  // Track which connection is selected as event source (visual state)
  const [eventSourceId, setEventSourceId] = useState<string | null>(null);

  const handleEventSourceSelect = (connId: string) => {
    setEventSourceId(connId);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* ---- When ---- */}
      <div className="flex flex-col gap-5">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          When
        </span>

        <PillToggle
          value={triggerType}
          onChange={(v) => form.setValue("triggerType", v, SET_OPTS)}
          options={[
            { value: "cron", label: "Schedule" },
            { value: "event", label: "Event" },
          ]}
        />

        {/* Schedule config */}
        {triggerType === "cron" && (
          <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-top-1 duration-150">
            <CronScheduleSelector
              value={cronExpression}
              onChange={(v) => form.setValue("cronExpression", v, SET_OPTS)}
            />
          </div>
        )}

        {/* Event config */}
        {triggerType === "event" && (
          <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">
                Triggered in
              </span>
              <Suspense fallback={<SelectorFallback />}>
                <EventSourceList
                  selectedId={eventSourceId}
                  onSelect={handleEventSourceSelect}
                />
              </Suspense>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">
                  Event type
                </span>
                <Input
                  placeholder="e.g., message_received"
                  {...form.register("eventType")}
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">
                  Filter (optional)
                </span>
                <Input
                  placeholder="JSONPath filter on event data"
                  {...form.register("eventFilter")}
                  className="h-8 text-sm"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border/40" />

      {/* ---- Then ---- */}
      <div className="flex flex-col gap-5">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Then
        </span>

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
            <Suspense fallback={<SelectorFallback />}>
              <ToolComboboxContent
                value={toolName}
                connectionId={connectionId}
                onChange={(tool, conn) => {
                  form.setValue("toolName", tool, SET_OPTS);
                  form.setValue("connectionId", conn, SET_OPTS);
                }}
              />
            </Suspense>
            {toolName && (
              <div className="flex flex-col gap-1.5 animate-in fade-in duration-150">
                <span className="text-xs text-muted-foreground">
                  Arguments (optional JSON)
                </span>
                <Textarea
                  placeholder='{"channel": "#general", "message": "Hello"}'
                  rows={3}
                  className="font-mono text-xs resize-none"
                  {...form.register("toolArguments")}
                />
              </div>
            )}
          </div>
        )}

        {actionType === "agent_prompt" && (
          <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-top-1 duration-150">
            <Suspense fallback={<SelectorFallback />}>
              <AgentSelector
                value={agentId}
                onChange={(v) => form.setValue("agentId", v, SET_OPTS)}
              />
            </Suspense>
            {agentId && (
              <div className="flex flex-col gap-1.5 animate-in fade-in duration-150">
                <span className="text-xs text-muted-foreground">Prompt</span>
                <Textarea
                  placeholder="Check the latest emails and summarize for the team"
                  rows={3}
                  className="resize-none"
                  {...form.register("agentPrompt")}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

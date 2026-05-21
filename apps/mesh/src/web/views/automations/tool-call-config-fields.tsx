/**
 * Form fields for configuring a kind="tool_call" automation: connection
 * picker, tool picker, and a schema-driven input form.
 *
 * The pickers are Popover + Command combos rendered with IntegrationIcon
 * — same pattern as `BranchPicker` etc. — so the user sees the
 * connection's icon and description instead of a bare slug. The input
 * editor is the workflow's `ToolInput` (RJSF), so it generates the right
 * widget for each property in the tool's inputSchema.
 *
 * Value shape: { connectionId, toolName, input }. `input` is an object
 * (not a JSON string) so callers don't have to parse / re-stringify on
 * every keystroke — RJSF gives us a typed formData payload.
 */

import { Button } from "@deco/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import {
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useMCPToolsListQuery,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { Check, ChevronDown, Tool02 } from "@untitledui/icons";
import { useState } from "react";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { ToolParametersForm } from "@/web/components/tools/tool-parameters-form";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolCallConfigValue {
  connectionId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export function ToolCallConfigFields({
  value,
  onChange,
}: {
  value: ToolCallConfigValue;
  onChange: (next: ToolCallConfigValue) => void;
}) {
  const connections = useConnections();
  const visible = connections.filter((c) => c.id !== SELF_MCP_ALIAS_ID);
  const selectedConnection =
    visible.find((c) => c.id === value.connectionId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>Connection</Label>
        <ConnectionPicker
          connections={visible}
          selected={selectedConnection}
          onSelect={(c) =>
            // Clear the tool when the connection changes — tool names
            // don't carry across MCPs.
            onChange({
              ...value,
              connectionId: c.id,
              toolName: "",
              input: {},
            })
          }
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Tool</Label>
        {selectedConnection ? (
          <ToolPicker
            connection={selectedConnection}
            selectedToolName={value.toolName}
            onSelect={(tool) =>
              // Reset input when the tool changes — its schema is
              // different. Pre-populating from the previous tool would
              // surface stray keys that don't validate.
              onChange({ ...value, toolName: tool.name, input: {} })
            }
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled
            className="h-9 justify-start gap-2 px-3 text-sm font-normal text-muted-foreground"
          >
            <Tool02 className="size-4" />
            Pick a connection first
          </Button>
        )}
      </div>

      {selectedConnection && value.toolName ? (
        <div className="flex flex-col gap-1.5">
          <Label>Input</Label>
          <div className="rounded-md border border-border p-3">
            <ToolInputForm
              // Key on (connection, tool) so the input subtree is fully
              // remounted when either changes. RawJsonField inside has
              // local state for the JSON textarea — without a remount,
              // switching between two raw-JSON tools keeps the previous
              // tool's text visible while the parent's `input` is reset
              // to {}, so Test would run different args than displayed.
              key={`${selectedConnection.id}:${value.toolName}`}
              connection={selectedConnection}
              toolName={value.toolName}
              input={value.input}
              onChange={(input) => onChange({ ...value, input })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionPicker({
  connections,
  selected,
  onSelect,
}: {
  connections: ConnectionEntity[];
  selected: ConnectionEntity | null;
  onSelect: (c: ConnectionEntity) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 justify-between gap-2 px-3 text-sm font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <>
                <IntegrationIcon
                  icon={selected.icon}
                  name={selected.title}
                  size="2xs"
                />
                <span className="truncate">{selected.title}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Pick a connection</span>
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(420px,calc(100vw-2rem))] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder="Search connections…" />
          <CommandList>
            <CommandEmpty>No connections found.</CommandEmpty>
            <CommandGroup>
              {connections.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`${c.title} ${c.description ?? ""} ${c.id}`}
                  onSelect={() => {
                    onSelect(c);
                    setOpen(false);
                  }}
                  className="flex items-start gap-2.5"
                >
                  <IntegrationIcon icon={c.icon} name={c.title} size="xs" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{c.title}</div>
                    {c.description && (
                      <div className="text-xs text-muted-foreground line-clamp-2">
                        {c.description}
                      </div>
                    )}
                  </div>
                  <Check
                    className={cn(
                      "size-4 shrink-0 mt-0.5",
                      selected?.id === c.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ToolPicker({
  connection,
  selectedToolName,
  onSelect,
}: {
  connection: ConnectionEntity;
  selectedToolName: string;
  onSelect: (tool: Tool) => void;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: connection.id,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data, isLoading, error } = useMCPToolsListQuery({ client });
  const tools = data?.tools ?? [];
  const selectedTool = tools.find((t) => t.name === selectedToolName) ?? null;
  const [open, setOpen] = useState(false);

  const triggerLabel = (() => {
    if (selectedTool) return selectedTool.name;
    if (error) return `Failed to load tools: ${error.message}`;
    if (isLoading) return "Loading tools…";
    if (tools.length === 0) return "No tools available";
    return "Pick a tool";
  })();

  const disabled = isLoading || !!error || tools.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-9 justify-between gap-2 px-3 text-sm font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <IntegrationIcon
              icon={connection.icon}
              name={connection.title}
              size="2xs"
            />
            <span
              className={cn(
                "truncate font-mono text-xs",
                !selectedTool && "text-muted-foreground font-sans",
              )}
            >
              {triggerLabel}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(480px,calc(100vw-2rem))] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder="Search tools…" />
          <CommandList>
            <CommandEmpty>No tools found.</CommandEmpty>
            <CommandGroup>
              {tools.map((t) => (
                <CommandItem
                  key={t.name}
                  value={`${t.name} ${t.description ?? ""}`}
                  onSelect={() => {
                    onSelect(t);
                    setOpen(false);
                  }}
                  className="flex items-start gap-2.5"
                >
                  <Tool02 className="size-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono truncate">{t.name}</div>
                    {t.description && (
                      <div className="text-xs text-muted-foreground line-clamp-2">
                        {t.description}
                      </div>
                    )}
                  </div>
                  <Check
                    className={cn(
                      "size-4 shrink-0 mt-0.5",
                      selectedToolName === t.name ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ToolInputForm({
  connection,
  toolName,
  input,
  onChange,
}: {
  connection: ConnectionEntity;
  toolName: string;
  input: Record<string, unknown>;
  onChange: (input: Record<string, unknown>) => void;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: connection.id,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data, isLoading, error } = useMCPToolsListQuery({ client });
  const tool = data?.tools?.find((t) => t.name === toolName) ?? null;

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground italic">
        Loading tool schema…
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-sm text-destructive">
        Failed to load tool schema: {error.message}
      </div>
    );
  }
  if (!tool) {
    return (
      <div className="text-sm text-muted-foreground italic">
        Tool {toolName} not found on this connection.
      </div>
    );
  }

  return (
    <ToolParametersForm
      inputSchema={tool.inputSchema}
      value={input}
      onChange={onChange}
    />
  );
}

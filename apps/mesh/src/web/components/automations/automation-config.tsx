/**
 * Automation config controls — per-automation model override and tool
 * allowlist. Both are optional refinements over the agent's defaults:
 *   - Model: by default the org tier preset (fast/smart/thinking) is used.
 *     Flipping "Use a specific model" pins a concrete model + credential.
 *   - Tools: by default the bound agent's full toolset runs. The picker
 *     narrows it to a subset (MCP tools + capability built-ins).
 */

import { Suspense, useState } from "react";
import {
  Atom01,
  Check,
  ChevronDown,
  Cube01,
  GitBranch01,
  Globe01,
  HelpCircle,
  Image01,
  Lightning01,
  Stars01,
  Tool01,
} from "@untitledui/icons";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
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
import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import {
  useConnections,
  useMCPClient,
  useMCPToolsListQuery,
  useProjectContext,
  type AiProviderModel,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { type SimpleModeTier } from "@/web/components/chat/simple-mode-tier-dropdown";
import { ModelSelector } from "@/web/components/chat/select-model";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";

const TIER_META: Record<
  SimpleModeTier,
  { label: string; subtitle: string; icon: typeof Lightning01 }
> = {
  fast: {
    label: "Fast",
    subtitle: "Quick responses for simple tasks",
    icon: Lightning01,
  },
  smart: {
    label: "Smart",
    subtitle: "Balanced quality and speed",
    icon: Stars01,
  },
  thinking: {
    label: "Thinking",
    subtitle: "Deeper reasoning for hard tasks",
    icon: Atom01,
  },
};

const TIER_ORDER: SimpleModeTier[] = ["fast", "smart", "thinking"];

/** Self-contained tier dropdown styled to match the Tools control (the chat
 *  `SimpleModeTierDropdown` is tuned for the chat input bar and collapses to a
 *  bare icon outside a `@container/chat-bottom` ancestor). */
function TierDropdown({
  tier,
  onSelect,
}: {
  tier: SimpleModeTier;
  onSelect: (t: SimpleModeTier) => void;
}) {
  const [open, setOpen] = useState(false);
  const Active = TIER_META[tier].icon;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-fit gap-1.5">
          <Active size={14} className="text-muted-foreground" />
          {TIER_META[tier].label}
          <ChevronDown size={14} className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-1 w-64">
        <div className="flex flex-col">
          {TIER_ORDER.map((t) => {
            const meta = TIER_META[t];
            const Icon = meta.icon;
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  onSelect(t);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-start gap-2 px-2 py-1.5 rounded-md text-left hover:bg-muted",
                )}
              >
                <Icon
                  size={16}
                  className="shrink-0 text-muted-foreground mt-0.5"
                />
                <div className="flex-1">
                  <div className="text-sm">{meta.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {meta.subtitle}
                  </div>
                </div>
                {t === tier && (
                  <Check size={14} className="text-foreground mt-0.5" />
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Model control
// ============================================================================

export interface AutomationModelOverride {
  modelId: string;
  credentialId: string;
  title: string;
}

export function AutomationModelControl({
  tier,
  onTierChange,
  override,
  onOverrideChange,
}: {
  tier: SimpleModeTier;
  onTierChange: (t: SimpleModeTier) => void;
  override: AutomationModelOverride | null;
  onOverrideChange: (o: AutomationModelOverride | null) => void;
}) {
  // Local toggle so "switch on, nothing picked yet" reveals the picker without
  // committing a half-formed override (the fire path falls back to the tier
  // when modelId/credentialId aren't both set, so this stays safe regardless).
  const [useSpecific, setUseSpecific] = useState(override !== null);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground/60">
        Model
      </span>
      <div className="flex items-center gap-3 flex-wrap">
        {useSpecific ? (
          <Suspense
            fallback={
              <Button variant="outline" size="sm" disabled className="w-fit">
                Loading models…
              </Button>
            }
          >
            <SpecificModelPicker
              override={override}
              onOverrideChange={onOverrideChange}
            />
          </Suspense>
        ) : (
          <TierDropdown tier={tier} onSelect={onTierChange} />
        )}
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <Switch
            checked={useSpecific}
            onCheckedChange={(on) => {
              setUseSpecific(on);
              // Turning it off reverts to the tier preset.
              if (!on) onOverrideChange(null);
            }}
            className="cursor-pointer"
          />
          Specific model
        </label>
      </div>
    </div>
  );
}

/**
 * The concrete model + credential picker. Pre-selects the org's first AI
 * provider key so the model list is populated immediately (an unselected
 * credential renders an empty, broken-looking dialog).
 */
function SpecificModelPicker({
  override,
  onOverrideChange,
}: {
  override: AutomationModelOverride | null;
  onOverrideChange: (o: AutomationModelOverride | null) => void;
}) {
  const keys = useAiProviderKeys();
  const defaultKeyId = keys[0]?.id ?? null;
  const [credentialId, setCredentialId] = useState<string | null>(
    override?.credentialId ?? defaultKeyId,
  );

  const resolvedModel: AiProviderModel | null = override
    ? ({
        modelId: override.modelId,
        title: override.title || override.modelId,
        keyId: override.credentialId,
        providerId: "deco",
        description: null,
        logo: null,
        capabilities: [],
        limits: null,
        costs: null,
      } as AiProviderModel)
    : null;

  if (keys.length === 0) {
    return (
      <span className="text-xs text-muted-foreground italic">
        Connect an AI provider in settings to pick a specific model.
      </span>
    );
  }

  return (
    <div className="w-fit max-w-full [&_button]:rounded-md">
      <ModelSelector
        variant="bordered"
        placeholder="Pick a model"
        model={resolvedModel}
        credentialId={credentialId}
        onCredentialChange={setCredentialId}
        onModelChange={(m) => {
          const keyId = m.keyId ?? credentialId ?? "";
          setCredentialId(keyId);
          onOverrideChange({
            modelId: m.modelId,
            credentialId: keyId,
            title: m.title ?? m.modelId,
          });
        }}
      />
    </div>
  );
}

// ============================================================================
// Tools control
// ============================================================================

/**
 * User-facing capability built-ins the allowlist can govern. Loop-essential
 * built-ins (read_tool_output, enable_tool, …) are intentionally absent — they
 * are never filtered out (see assemble-decopilot-tools).
 */
const CAPABILITY_BUILTINS: {
  name: string;
  title: string;
  description: string;
  icon: typeof Tool01;
}[] = [
  {
    name: "web_search",
    title: "Web search",
    description: "Look up current information on the web",
    icon: Globe01,
  },
  {
    name: "generate_image",
    title: "Generate image",
    description: "Create images from a text prompt",
    icon: Image01,
  },
  {
    name: "subtask",
    title: "Subtask",
    description: "Spawn a focused sub-agent to handle part of the work",
    icon: GitBranch01,
  },
  {
    name: "user_ask",
    title: "Ask the user",
    description: "Pause to ask the user a clarifying question",
    icon: HelpCircle,
  },
];

/** Turn `GET_CALENDAR_EVENTS` / `get-calendar` into "Get Calendar Events". */
function humanizeToolName(raw: string): string {
  const words = raw.replace(/[_-]+/g, " ").trim();
  if (!words) return raw;
  return words.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

interface PickerTool {
  /** Full namespaced name — the value stored in the allowlist. */
  name: string;
  /** Friendly, de-namespaced label. */
  display: string;
  description?: string;
}

interface ToolGroup {
  clientId: string;
  conn?: ConnectionEntity;
  tools: PickerTool[];
}

export function AutomationToolsControl({
  agentId,
  value,
  onChange,
}: {
  agentId: string | null;
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground/60">
        Tools
      </span>
      {agentId ? (
        <Suspense
          fallback={
            <Button variant="outline" size="sm" disabled className="w-fit">
              <Tool01 size={14} />
              Loading tools…
            </Button>
          }
        >
          <ToolsPicker agentId={agentId} value={value} onChange={onChange} />
        </Suspense>
      ) : (
        <span className="text-xs text-muted-foreground italic">
          Pick an agent first
        </span>
      )}
    </div>
  );
}

/** A single selectable tool row: checkbox + optional leading icon + label and
 *  an optional description subtitle. */
function ToolRow({
  value,
  checked,
  onToggle,
  title,
  description,
  leading,
}: {
  value: string;
  checked: boolean;
  onToggle: () => void;
  title: string;
  description?: string;
  leading?: React.ReactNode;
}) {
  return (
    <CommandItem
      value={value}
      onSelect={onToggle}
      className="items-start gap-2.5 py-2"
    >
      <Checkbox checked={checked} className="pointer-events-none mt-0.5" />
      {leading && <span className="mt-px shrink-0">{leading}</span>}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm leading-tight">{title}</span>
        {description && (
          <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        )}
      </div>
    </CommandItem>
  );
}

/** Group header for a source connection: icon + name + n/total + All/None. */
function GroupHeading({
  conn,
  on,
  total,
  onToggle,
}: {
  conn?: ConnectionEntity;
  on: number;
  total: number;
  onToggle: () => void;
}) {
  const allOn = on === total;
  return (
    <div className="flex items-center gap-2">
      {conn ? (
        <IntegrationIcon icon={conn.icon} name={conn.title} size="2xs" />
      ) : (
        <Cube01 size={14} className="text-muted-foreground" />
      )}
      <span className="truncate">{conn?.title ?? "Other tools"}</span>
      <span className="ml-auto flex items-center gap-2">
        <span className="text-[11px] font-normal tabular-nums text-muted-foreground/70">
          {on}/{total}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="text-[11px] font-medium text-primary hover:underline"
        >
          {allOn ? "None" : "All"}
        </button>
      </span>
    </div>
  );
}

function ToolsPicker({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const { org } = useProjectContext();
  const [open, setOpen] = useState(false);
  const client = useMCPClient({
    connectionId: agentId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data, isLoading } = useMCPToolsListQuery({ client });
  const connections = useConnections();
  const connById = new Map(connections.map((c) => [c.id, c]));

  // Group the agent's aggregated tools by their source connection so the raw
  // `conn-<id>_<TOOL>` names become a friendly, scannable list.
  const groups = new Map<string, ToolGroup>();
  for (const t of data?.tools ?? []) {
    const clientId = getGatewayClientId(t._meta) ?? "__other__";
    const stripped = stripToolNamespace(
      t.name,
      clientId === "__other__" ? undefined : clientId,
    );
    const rawTitle = (t as { title?: string }).title;
    const display =
      rawTitle && rawTitle !== t.name ? rawTitle : humanizeToolName(stripped);
    if (!groups.has(clientId)) {
      groups.set(clientId, {
        clientId,
        conn: connById.get(clientId),
        tools: [],
      });
    }
    groups.get(clientId)!.tools.push({
      name: t.name,
      display,
      description: (t as { description?: string }).description,
    });
  }
  const groupList = [...groups.values()].sort((a, b) =>
    (a.conn?.title ?? a.clientId).localeCompare(b.conn?.title ?? b.clientId),
  );

  const mcpNames = (data?.tools ?? []).map((t) => t.name);
  const allNames = [...CAPABILITY_BUILTINS.map((t) => t.name), ...mcpNames];
  // null = all tools. Materialize to a Set for toggling.
  const selected = value === null ? new Set(allNames) : new Set(value);
  const allSelected = allNames.every((n) => selected.has(n));

  // Collapsing back to "everything selected" stores null so a later tool added
  // to the agent is automatically included.
  const commit = (next: Set<string>) =>
    onChange(allNames.every((n) => next.has(n)) ? null : [...next]);
  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    commit(next);
  };
  const toggleGroup = (names: string[], on: boolean) => {
    const next = new Set(selected);
    for (const n of names) {
      if (on) next.add(n);
      else next.delete(n);
    }
    commit(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-fit gap-1.5">
          <Tool01 size={14} className="text-muted-foreground" />
          {allSelected ? "All tools" : "Tools"}
          {!allSelected && (
            <Badge
              variant="secondary"
              className="ml-0.5 h-5 px-1.5 text-[11px] tabular-nums"
            >
              {selected.size}/{allNames.length}
            </Badge>
          )}
          <ChevronDown size={14} className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-80" align="start">
        <Command>
          <CommandInput placeholder="Search tools..." />
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {allSelected
                ? `All ${allNames.length} tools enabled`
                : `${selected.size} of ${allNames.length} enabled`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onChange(null)}
                disabled={allSelected}
                className="text-xs font-medium text-primary hover:underline disabled:cursor-default disabled:opacity-40 disabled:no-underline"
              >
                Select all
              </button>
              <span className="text-muted-foreground/30">·</span>
              <button
                type="button"
                onClick={() => onChange([])}
                disabled={selected.size === 0}
                className="text-xs font-medium text-muted-foreground hover:underline disabled:cursor-default disabled:opacity-40 disabled:no-underline"
              >
                Clear
              </button>
            </div>
          </div>
          <CommandList className="max-h-80">
            {isLoading ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                Loading tools…
              </div>
            ) : (
              <>
                <CommandEmpty>No tools found</CommandEmpty>
                <CommandGroup heading="Built-in capabilities">
                  {CAPABILITY_BUILTINS.map((t) => (
                    <ToolRow
                      key={t.name}
                      value={`${t.title} ${t.name}`}
                      checked={selected.has(t.name)}
                      onToggle={() => toggle(t.name)}
                      title={t.title}
                      description={t.description}
                      leading={
                        <t.icon size={16} className="text-muted-foreground" />
                      }
                    />
                  ))}
                </CommandGroup>
                {groupList.map((g) => {
                  const names = g.tools.map((t) => t.name);
                  const on = names.filter((n) => selected.has(n)).length;
                  return (
                    <CommandGroup
                      key={g.clientId}
                      heading={
                        <GroupHeading
                          conn={g.conn}
                          on={on}
                          total={names.length}
                          onToggle={() =>
                            toggleGroup(names, on !== names.length)
                          }
                        />
                      }
                    >
                      {g.tools.map((t) => (
                        <ToolRow
                          key={t.name}
                          value={`${t.display} ${t.name} ${g.conn?.title ?? ""}`}
                          checked={selected.has(t.name)}
                          onToggle={() => toggle(t.name)}
                          title={t.display}
                          description={t.description}
                        />
                      ))}
                    </CommandGroup>
                  );
                })}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

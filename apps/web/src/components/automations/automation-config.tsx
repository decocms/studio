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
  BookOpen01,
  Check,
  ChevronDown,
  Code01,
  Cube01,
  Database01,
  Edit01,
  Edit02,
  File06,
  Folder,
  GitBranch01,
  Globe01,
  Globe02,
  HelpCircle,
  Image01,
  Lightning01,
  Monitor01,
  SearchMd,
  Stars01,
  TerminalSquare,
  Tool01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
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
} from "@/sdk";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { type SimpleModeTier } from "@/components/chat/simple-mode-tier-dropdown";
import { ModelSelector } from "@/components/chat/select-model";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";

const TIER_META: Record<
  SimpleModeTier,
  {
    labelKey: TranslationKey;
    subtitleKey: TranslationKey;
    icon: typeof Lightning01;
  }
> = {
  fast: {
    labelKey: "automations.automationConfig.tierFast",
    subtitleKey: "automations.automationConfig.tierFastSubtitle",
    icon: Lightning01,
  },
  smart: {
    labelKey: "automations.automationConfig.tierSmart",
    subtitleKey: "automations.automationConfig.tierSmartSubtitle",
    icon: Stars01,
  },
  thinking: {
    labelKey: "automations.automationConfig.tierThinking",
    subtitleKey: "automations.automationConfig.tierThinkingSubtitle",
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const Active = TIER_META[tier].icon;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-fit gap-1.5">
          <Active size={14} className="text-muted-foreground" />
          {t(TIER_META[tier].labelKey)}
          <ChevronDown size={14} className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-1 w-64">
        <div className="flex flex-col">
          {TIER_ORDER.map((tierOption) => {
            const meta = TIER_META[tierOption];
            const Icon = meta.icon;
            return (
              <button
                key={tierOption}
                type="button"
                onClick={() => {
                  onSelect(tierOption);
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
                  <div className="text-sm">{t(meta.labelKey)}</div>
                  <div className="text-xs text-muted-foreground">
                    {t(meta.subtitleKey)}
                  </div>
                </div>
                {tierOption === tier && (
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
  const t = useT();
  // Local toggle so "switch on, nothing picked yet" reveals the picker without
  // committing a half-formed override (the fire path falls back to the tier
  // when modelId/credentialId aren't both set, so this stays safe regardless).
  const [useSpecific, setUseSpecific] = useState(override !== null);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground/60">
        {t("automations.automationConfig.modelLabel")}
      </span>
      <div className="flex items-center gap-3 flex-wrap">
        {useSpecific ? (
          <Suspense
            fallback={
              <Button variant="outline" size="sm" disabled className="w-fit">
                {t("automations.automationConfig.loadingModels")}
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
          {t("automations.automationConfig.specificModel")}
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
  const t = useT();
  const keys = useHostedAiProviderKeys();
  const defaultKeyId = keys[0]?.id ?? null;
  const [credentialId, setCredentialId] = useState<string | null>(
    keys.some((key) => key.id === override?.credentialId)
      ? (override?.credentialId ?? null)
      : defaultKeyId,
  );
  const activeCredentialId = keys.some((key) => key.id === credentialId)
    ? credentialId
    : defaultKeyId;

  const resolvedModel: AiProviderModel | null =
    override && keys.some((key) => key.id === override.credentialId)
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
        {t("automations.automationConfig.connectAiProviderHint")}
      </span>
    );
  }

  return (
    <div className="w-fit max-w-full [&_button]:rounded-md">
      <ModelSelector
        variant="bordered"
        placeholder={t("automations.automationConfig.pickModelPlaceholder")}
        model={resolvedModel}
        credentialId={activeCredentialId}
        onCredentialChange={setCredentialId}
        onModelChange={(m) => {
          const keyId = m.keyId ?? activeCredentialId ?? "";
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

interface BuiltinDef {
  name: string;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: typeof Tool01;
}

interface BuiltinGroup {
  key: string;
  headingKey: TranslationKey;
  icon: typeof Tool01;
  tools: BuiltinDef[];
}

/**
 * Governable built-in tools, grouped for the picker. The allowlist can toggle
 * every tool listed here. Loop-essential built-ins (read_tool_output,
 * enable_tool, todo_write, update_interests, open_in_agent) are intentionally
 * absent — they are never filtered out (see ALLOWLIST_EXEMPT_BUILTINS in
 * harnesses/decopilot/tools.ts). The set mirrors what the agent can actually
 * run; tools not provisioned for a given agent (e.g. browser tools without a
 * BROWSERLESS_TOKEN, VM tools without a sandbox) simply never appear at
 * runtime, so toggling them off is a harmless no-op.
 */
const BUILTIN_GROUPS: BuiltinGroup[] = [
  {
    key: "capabilities",
    headingKey: "automations.automationConfig.builtinCapabilities",
    icon: Tool01,
    tools: [
      {
        name: "web_search",
        titleKey: "automations.automationConfig.toolWebSearch",
        descriptionKey: "automations.automationConfig.toolWebSearchDesc",
        icon: Globe01,
      },
      {
        name: "generate_image",
        titleKey: "automations.automationConfig.toolGenerateImage",
        descriptionKey: "automations.automationConfig.toolGenerateImageDesc",
        icon: Image01,
      },
      {
        name: "subtask",
        titleKey: "automations.automationConfig.toolSubtask",
        descriptionKey: "automations.automationConfig.toolSubtaskDesc",
        icon: GitBranch01,
      },
      {
        name: "user_ask",
        titleKey: "automations.automationConfig.toolAskUser",
        descriptionKey: "automations.automationConfig.toolAskUserDesc",
        icon: HelpCircle,
      },
    ],
  },
  {
    key: "files",
    headingKey: "automations.automationConfig.filesCode",
    icon: Folder,
    tools: [
      {
        name: "read",
        titleKey: "automations.automationConfig.toolReadFile",
        descriptionKey: "automations.automationConfig.toolReadFileDesc",
        icon: File06,
      },
      {
        name: "write",
        titleKey: "automations.automationConfig.toolWriteFile",
        descriptionKey: "automations.automationConfig.toolWriteFileDesc",
        icon: Edit01,
      },
      {
        name: "edit",
        titleKey: "automations.automationConfig.toolEditFile",
        descriptionKey: "automations.automationConfig.toolEditFileDesc",
        icon: Edit02,
      },
      {
        name: "grep",
        titleKey: "automations.automationConfig.toolSearchContent",
        descriptionKey: "automations.automationConfig.toolSearchContentDesc",
        icon: SearchMd,
      },
      {
        name: "glob",
        titleKey: "automations.automationConfig.toolFindFiles",
        descriptionKey: "automations.automationConfig.toolFindFilesDesc",
        icon: Folder,
      },
      {
        name: "bash",
        titleKey: "automations.automationConfig.toolRunCommand",
        descriptionKey: "automations.automationConfig.toolRunCommandDesc",
        icon: TerminalSquare,
      },
    ],
  },
  {
    key: "context",
    headingKey: "automations.automationConfig.context",
    icon: Database01,
    tools: [
      {
        name: "read_resource",
        titleKey: "automations.automationConfig.toolReadResource",
        descriptionKey: "automations.automationConfig.toolReadResourceDesc",
        icon: Database01,
      },
      {
        name: "read_prompt",
        titleKey: "automations.automationConfig.toolReadPrompt",
        descriptionKey: "automations.automationConfig.toolReadPromptDesc",
        icon: BookOpen01,
      },
      {
        name: "skill",
        titleKey: "automations.automationConfig.toolLoadSkill",
        descriptionKey: "automations.automationConfig.toolLoadSkillDesc",
        icon: BookOpen01,
      },
    ],
  },
  {
    key: "browser",
    headingKey: "automations.automationConfig.browser",
    icon: Globe02,
    tools: [
      {
        name: "take_screenshot",
        titleKey: "automations.automationConfig.toolTakeScreenshot",
        descriptionKey: "automations.automationConfig.toolTakeScreenshotDesc",
        icon: Monitor01,
      },
      {
        name: "scrape_url",
        titleKey: "automations.automationConfig.toolScrapeUrl",
        descriptionKey: "automations.automationConfig.toolScrapeUrlDesc",
        icon: Globe02,
      },
      {
        name: "inspect_page",
        titleKey: "automations.automationConfig.toolInspectPage",
        descriptionKey: "automations.automationConfig.toolInspectPageDesc",
        icon: Code01,
      },
    ],
  },
];

/** Flat list of every governable built-in tool name across all groups. */
const BUILTIN_NAMES = BUILTIN_GROUPS.flatMap((g) => g.tools.map((t) => t.name));

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
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground/60">
        {t("automations.automationConfig.toolsLabel")}
      </span>
      {agentId ? (
        <Suspense
          fallback={
            <Button variant="outline" size="sm" disabled className="w-fit">
              <Tool01 size={14} />
              {t("automations.automationConfig.loadingTools")}
            </Button>
          }
        >
          <ToolsPicker agentId={agentId} value={value} onChange={onChange} />
        </Suspense>
      ) : (
        <span className="text-xs text-muted-foreground italic">
          {t("automations.automationConfig.pickAgentFirst")}
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

/** Group header: icon + name + n/total + All/None. Used both for source
 *  connections (pass `conn`) and built-in groups (pass `label` + `icon`). */
function GroupHeading({
  conn,
  label,
  icon: Icon,
  on,
  total,
  onToggle,
}: {
  conn?: ConnectionEntity;
  label?: string;
  icon?: typeof Tool01;
  on: number;
  total: number;
  onToggle: () => void;
}) {
  const t = useT();
  const allOn = on === total;
  return (
    <div className="flex items-center gap-2">
      {conn ? (
        <IntegrationIcon icon={conn.icon} name={conn.title} size="2xs" />
      ) : Icon ? (
        <Icon size={14} className="text-muted-foreground" />
      ) : (
        <Cube01 size={14} className="text-muted-foreground" />
      )}
      <span className="truncate">
        {conn?.title ?? label ?? t("automations.automationConfig.otherTools")}
      </span>
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
          {allOn
            ? t("automations.automationConfig.none")
            : t("automations.automationConfig.all")}
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
  const t = useT();
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
  for (const tool of data?.tools ?? []) {
    const clientId = getGatewayClientId(tool._meta) ?? "__other__";
    const stripped = stripToolNamespace(
      tool.name,
      clientId === "__other__" ? undefined : clientId,
    );
    const rawTitle = (tool as { title?: string }).title;
    const display =
      rawTitle && rawTitle !== tool.name
        ? rawTitle
        : humanizeToolName(stripped);
    if (!groups.has(clientId)) {
      groups.set(clientId, {
        clientId,
        conn: connById.get(clientId),
        tools: [],
      });
    }
    groups.get(clientId)!.tools.push({
      name: tool.name,
      display,
      description: (tool as { description?: string }).description,
    });
  }
  const groupList = [...groups.values()].sort((a, b) =>
    (a.conn?.title ?? a.clientId).localeCompare(b.conn?.title ?? b.clientId),
  );

  const mcpNames = (data?.tools ?? []).map((tool) => tool.name);
  const allNames = [...BUILTIN_NAMES, ...mcpNames];
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
          {allSelected
            ? t("automations.automationConfig.allTools")
            : t("automations.automationConfig.tools")}
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
          <CommandInput
            placeholder={t(
              "automations.automationConfig.searchToolsPlaceholder",
            )}
          />
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {allSelected
                ? t("automations.automationConfig.allToolsEnabled", {
                    count: allNames.length,
                  })
                : t("automations.automationConfig.toolsEnabledCount", {
                    enabled: selected.size,
                    total: allNames.length,
                  })}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onChange(null)}
                disabled={allSelected}
                className="text-xs font-medium text-primary hover:underline disabled:cursor-default disabled:opacity-40 disabled:no-underline"
              >
                {t("automations.automationConfig.selectAll")}
              </button>
              <span className="text-muted-foreground/30">·</span>
              <button
                type="button"
                onClick={() => onChange([])}
                disabled={selected.size === 0}
                className="text-xs font-medium text-muted-foreground hover:underline disabled:cursor-default disabled:opacity-40 disabled:no-underline"
              >
                {t("automations.automationConfig.clear")}
              </button>
            </div>
          </div>
          <CommandList className="max-h-80">
            {isLoading ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("automations.automationConfig.loadingTools")}
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {t("automations.automationConfig.noToolsFound")}
                </CommandEmpty>
                {BUILTIN_GROUPS.map((g) => {
                  const names = g.tools.map((tool) => tool.name);
                  const on = names.filter((n) => selected.has(n)).length;
                  return (
                    <CommandGroup
                      key={g.key}
                      heading={
                        <GroupHeading
                          label={t(g.headingKey)}
                          icon={g.icon}
                          on={on}
                          total={names.length}
                          onToggle={() =>
                            toggleGroup(names, on !== names.length)
                          }
                        />
                      }
                    >
                      {g.tools.map((tool) => (
                        <ToolRow
                          key={tool.name}
                          value={`${t(tool.titleKey)} ${tool.name}`}
                          checked={selected.has(tool.name)}
                          onToggle={() => toggle(tool.name)}
                          title={t(tool.titleKey)}
                          description={t(tool.descriptionKey)}
                          leading={
                            <tool.icon
                              size={16}
                              className="text-muted-foreground"
                            />
                          }
                        />
                      ))}
                    </CommandGroup>
                  );
                })}
                {groupList.map((g) => {
                  const names = g.tools.map((tool) => tool.name);
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
                      {g.tools.map((tool) => (
                        <ToolRow
                          key={tool.name}
                          value={`${tool.display} ${tool.name} ${g.conn?.title ?? ""}`}
                          checked={selected.has(tool.name)}
                          onToggle={() => toggle(tool.name)}
                          title={tool.display}
                          description={tool.description}
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

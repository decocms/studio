import { useState, type ReactNode } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Atom01,
  ChevronDown,
  Check,
  Cloud01,
  Lightning01,
  Monitor01,
  Settings01,
  Stars01,
} from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import type { ChatTier } from "@decocms/shared/organization/schema";
import {
  resolveTierSubtitle,
  useAgentMode,
  useChatTier,
  useSetChatTier,
  type AgentMode,
} from "./use-agent-mode";
import { useChatPrefs, useOptionalChatTask } from "./context";
import { useEffectiveSimpleMode } from "@/hooks/use-user-model-preferences";
import {
  useAiProviderKeys,
  useAiProviderModels,
} from "@/hooks/collections/use-ai-providers";
import { pickFallbackChatModel } from "./resolve-chat-model";
import { UserModelPreferencesDialog } from "./user-model-preferences-dialog";
import { useAgentOptionAvailability } from "./use-agent-availability";
import {
  type AgentOption,
  preferredLocalAgentOption,
} from "./pills/agent-options";
import { ClaudeCodeIcon, CodexIcon, localHarnessBrand } from "./agent-icons";

const TIER_ORDER: ChatTier[] = ["fast", "smart", "thinking"];

/** One selectable row in the popover — a concrete (runtime, tier) choice. */
interface TierRow {
  key: string;
  icon?: ReactNode;
  title: string;
  subtitle?: string | null;
  active: boolean;
  onSelect: () => void;
}

/**
 * A labelled cluster of rows. The `label` is the small-font runtime heading
 * (e.g. "Claude Code", "Codex") rendered above its tiers; omit it for a single
 * ungrouped list (Cloud, or a lone local CLI).
 */
interface TierGroup {
  key: string;
  label?: string;
  rows: TierRow[];
}

interface PureProps {
  /** Active tier — drives the closed-pill label. */
  tier: ChatTier;
  /** Optional glyph rendered on the closed pill next to the tier label. */
  pillIcon?: ReactNode;
  /** Accessible label and tooltip for the closed pill. Defaults to the tier. */
  pillLabel?: string;
  /** Runtime × tier options, grouped by runtime. */
  groups: TierGroup[];
  /** Optional content rendered above the groups (the runtime toggle). */
  header?: ReactNode;
  /** When set, a footer row inside the panel opens the model picker. */
  onOpenPreferences?: () => void;
}

/**
 * Pure variant — no external dependencies (no context, no queries).
 * Owns only local UI state (the popover open flag) so tests can mount
 * it without mocking the chat context. Closed pill shows the icon
 * (when provided) + tier label; the popover renders `header` then one
 * block per group (optional heading + its rows). Selecting a row runs its
 * `onSelect` and closes the popover.
 */
export function TierTriggerPure({
  tier,
  pillIcon,
  pillLabel,
  groups,
  header,
  onOpenPreferences,
}: PureProps) {
  const t = useT();
  const getTierLabels = (): Record<ChatTier, string> => ({
    fast: t("chat.tierTrigger.tierFast"),
    smart: t("chat.tierTrigger.tierSmart"),
    thinking: t("chat.tierTrigger.tierThinking"),
  });
  const tierLabels = getTierLabels();
  const [open, setOpen] = useState(false);
  const handleSelect = (row: TierRow) => {
    row.onSelect();
    setOpen(false);
  };
  const resolvedPillLabel = pillLabel ?? tierLabels[tier];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 shrink">
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="default"
                aria-label={resolvedPillLabel}
                className={cn(
                  "text-muted-foreground hover:text-foreground transition-[gap] duration-200 shrink min-w-0",
                  "gap-0 @[320px]/chat-bottom:gap-1.5",
                )}
              >
                {pillIcon}
                <span
                  className={cn(
                    "min-w-0 truncate transition-[max-width,opacity] duration-200 ease-out max-w-0 opacity-0",
                    "@[320px]/chat-bottom:max-w-24 @[320px]/chat-bottom:opacity-100",
                  )}
                >
                  {tierLabels[tier]}
                </span>
                <ChevronDown
                  size={12}
                  className="opacity-60 hidden @[320px]/chat-bottom:inline-block"
                />
              </Button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{resolvedPillLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="p-1 w-64">
        {header && (
          <div className="mb-1 border-b border-border/60 pb-1">{header}</div>
        )}
        <div role="menu" className="flex flex-col">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col">
              {group.label && (
                <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
                  <span className="truncate">{group.label}</span>
                </div>
              )}
              {group.rows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  role="menuitem"
                  aria-label={
                    group.label ? `${group.label} ${row.title}` : row.title
                  }
                  onClick={() => handleSelect(row)}
                  className={cn(
                    "flex items-start gap-2 px-2 py-1.5 rounded-md text-left",
                    "hover:bg-muted",
                  )}
                >
                  {row.icon && (
                    <span className="shrink-0 text-muted-foreground mt-0.5">
                      {row.icon}
                    </span>
                  )}
                  <div className="flex-1">
                    <div className="text-sm">{row.title}</div>
                    {row.subtitle && (
                      <div className="text-xs text-muted-foreground">
                        {row.subtitle}
                      </div>
                    )}
                  </div>
                  {row.active && (
                    <span title={t("chat.tierTrigger.selected")}>
                      <Check size={14} className="text-foreground mt-0.5" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
        {onOpenPreferences && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenPreferences();
            }}
            className={cn(
              "mt-1 flex w-full items-center gap-2 border-t border-border/60 px-2 pt-2 pb-1.5",
              "text-left text-sm text-muted-foreground hover:text-foreground",
            )}
          >
            <Settings01 size={14} className="shrink-0" />
            <span className="truncate">
              {t("chat.modelPreferences.openLabel")}
            </span>
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Per-tier intent glyph (Lightning / Stars / Atom) used by the cloud runtime.
 * Local runtimes use their harness glyph on every tier instead, keeping the
 * active runtime legible from both the closed trigger and each menu row.
 */
function tierIconFor(tier: ChatTier): ReactNode {
  if (tier === "fast") return <Lightning01 size={16} />;
  if (tier === "thinking") return <Atom01 size={16} />;
  return <Stars01 size={16} />;
}

/**
 * The model name to show under each cloud tier: this user's override, else the
 * org slot, else the client-side mirror of the server's default pick — an org
 * that never saved `simple_mode` has null slots and `resolveTier` auto-picks
 * from the connected provider's catalog, so a name is still what a run uses.
 * Undefined only while the catalog is loading (caller falls back to the blurb).
 */
function useTierModelNames(): Record<ChatTier, string | undefined> {
  const effective = useEffectiveSimpleMode();
  const keys = useAiProviderKeys();
  const fallbackKeyId = keys[0]?.id ?? null;
  const { models } = useAiProviderModels(fallbackKeyId ?? undefined);

  const nameFor = (tier: ChatTier) => {
    const slot = effective.tiers[tier];
    if (slot) return slot.title ?? slot.modelId;
    return pickFallbackChatModel(tier, keys, fallbackKeyId, models)?.title;
  };
  return {
    fast: nameFor("fast"),
    smart: nameFor("smart"),
    thinking: nameFor("thinking"),
  };
}

const SEG_BTN =
  "flex items-center justify-center gap-1.5 flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors min-w-0";
const SEG_ACTIVE = "bg-background text-foreground shadow-sm";
const SEG_INACTIVE = "text-muted-foreground hover:text-foreground";

function Segmented({
  options,
}: {
  options: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    active: boolean;
    onSelect: () => void;
  }>;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-1 p-1 rounded-lg bg-muted">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={o.onSelect}
          className={cn(SEG_BTN, o.active ? SEG_ACTIVE : SEG_INACTIVE)}
          title={o.active ? t("chat.tierTrigger.selected") : undefined}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Runtime location toggle shown at the top of the tier popover when a desktop
 * is linked with a coding agent: Cloud (org router) ⟷ This device. Writes the
 * (harness, sandbox) choice through `pendingAgentOption`. The specific local
 * CLI (Claude / Codex) is no longer a nested toggle here — each CLI's tiers are
 * listed directly below as their own group. Hidden on a locked thread.
 */
function RuntimeToggle() {
  const t = useT();
  const { pendingHarnessId, setPendingAgentOption } = useChatPrefs();
  const availability = useAgentOptionAvailability();
  const isLocal =
    pendingHarnessId === "claude-code" || pendingHarnessId === "codex";
  // This toggle only renders when a local CLI is present (TierTrigger gates on
  // `hasLocal`), so the fallback is unreachable — but keep it total.
  const firstLocal: AgentOption =
    preferredLocalAgentOption(availability) ?? "claude-code-desktop";

  return (
    <div className="p-1">
      <Segmented
        options={[
          {
            key: "cloud",
            icon: <Cloud01 size={14} />,
            label: t("chat.tierTrigger.runtimeCloud"),
            active: !isLocal,
            onSelect: () => setPendingAgentOption("decopilot"),
          },
          {
            key: "local",
            icon: <Monitor01 size={14} />,
            label: t("chat.tierTrigger.runtimeThisDevice"),
            active: isLocal,
            onSelect: () => setPendingAgentOption(firstLocal),
          },
        ]}
      />
    </div>
  );
}

/** Build a runtime's three tier rows. Selecting a row pins the runtime (via
 *  `option`) and the tier in one click. */
function localGroup(params: {
  key: string;
  label: string | undefined;
  icon: ReactNode;
  mode: AgentMode;
  option: AgentOption;
  isActiveRuntime: boolean;
  currentTier: ChatTier;
  setOption: (option: AgentOption) => void;
  setTier: (tier: ChatTier) => void;
  tierLabels: Record<ChatTier, string>;
}): TierGroup {
  return {
    key: params.key,
    label: params.label,
    rows: TIER_ORDER.map((t) => ({
      key: `${params.key}-${t}`,
      icon: params.icon,
      title: params.tierLabels[t],
      subtitle: resolveTierSubtitle(params.mode, t),
      active: params.isActiveRuntime && params.currentTier === t,
      onSelect: () => {
        params.setOption(params.option);
        params.setTier(t);
      },
    })),
  };
}

/**
 * Smart wrapper used by `Chat.Input`. Reads current tier + mode, and builds the
 * popover groups. Cloud renders a single ungrouped list of tiers; when a
 * desktop is linked it surfaces the Cloud ⟷ This device toggle in the header
 * and — in local mode — lists each available CLI's tiers as its own group so a
 * single click picks both the runtime and the tier.
 */
export function TierTrigger() {
  const t = useT();
  const tier = useChatTier();
  const setTier = useSetChatTier();
  const mode = useAgentMode();
  const { pendingHarnessId, setPendingAgentOption } = useChatPrefs();
  const availability = useAgentOptionAvailability();
  const taskCtx = useOptionalChatTask();
  const locked = taskCtx?.isThreadLocked ?? false;
  const hasLocal = availability.claudeCode || availability.codex;
  const isLocal = mode !== "cloud-decopilot";
  const [prefsOpen, setPrefsOpen] = useState(false);
  // Per-tier model name (user override → org slot → auto-pick) shown as each
  // cloud row's subtitle.
  const tierModelNames = useTierModelNames();

  const getTierLabels = (): Record<ChatTier, string> => ({
    fast: t("chat.tierTrigger.tierFast"),
    smart: t("chat.tierTrigger.tierSmart"),
    thinking: t("chat.tierTrigger.tierThinking"),
  });
  const tierLabels = getTierLabels();

  let groups: TierGroup[];
  if (isLocal) {
    // A locked thread is pinned to one harness for its lifetime, so only that
    // CLI's group is real — listing the other would offer a switch that can't
    // happen. Otherwise show a CLI when it's detected, or when it's the active
    // runtime (so the popover never renders empty if detection lags). Label the
    // groups only when both are shown.
    const showClaude = locked
      ? pendingHarnessId === "claude-code"
      : availability.claudeCode || pendingHarnessId === "claude-code";
    const showCodex = locked
      ? pendingHarnessId === "codex"
      : availability.codex || pendingHarnessId === "codex";
    const bothShown = showClaude && showCodex;
    const built: TierGroup[] = [];
    if (showClaude) {
      built.push(
        localGroup({
          key: "claude-code",
          label: bothShown
            ? t("chat.tierTrigger.runtimeClaudeCode")
            : undefined,
          icon: <ClaudeCodeIcon size={16} />,
          mode: "local-claude-code",
          option: "claude-code-desktop",
          isActiveRuntime: pendingHarnessId === "claude-code",
          currentTier: tier,
          setOption: setPendingAgentOption,
          setTier,
          tierLabels,
        }),
      );
    }
    if (showCodex) {
      built.push(
        localGroup({
          key: "codex",
          label: bothShown ? t("chat.tierTrigger.runtimeCodex") : undefined,
          icon: <CodexIcon size={16} />,
          mode: "local-codex",
          option: "codex-desktop",
          isActiveRuntime: pendingHarnessId === "codex",
          currentTier: tier,
          setOption: setPendingAgentOption,
          setTier,
          tierLabels,
        }),
      );
    }
    groups = built;
  } else {
    groups = [
      {
        key: "cloud",
        rows: TIER_ORDER.map((t) => {
          const modelName = tierModelNames[t];
          return {
            key: `cloud-${t}`,
            icon: tierIconFor(t),
            title: tierLabels[t],
            // Show the concrete model backing this tier; fall back to the
            // intent blurb before the org config has loaded.
            subtitle: modelName ?? resolveTierSubtitle("cloud-decopilot", t),
            active: tier === t,
            onSelect: () => setTier(t),
          };
        }),
      },
    ];
  }

  const localBrand = isLocal ? localHarnessBrand(pendingHarnessId) : null;
  const LocalBrandIcon = localBrand?.Icon;

  const pure = (
    <TierTriggerPure
      tier={tier}
      pillIcon={
        LocalBrandIcon ? <LocalBrandIcon size={16} /> : tierIconFor(tier)
      }
      pillLabel={
        localBrand
          ? `${t(localBrand.labelKey)} ${tierLabels[tier]}`
          : tierLabels[tier]
      }
      groups={groups}
      header={hasLocal && !locked ? <RuntimeToggle /> : undefined}
      // Cloud mode only: local CLI tiers are fixed per harness, so there's
      // nothing to override.
      onOpenPreferences={isLocal ? undefined : () => setPrefsOpen(true)}
    />
  );

  if (isLocal) return pure;

  return (
    <>
      {pure}
      <UserModelPreferencesDialog
        open={prefsOpen}
        onOpenChange={setPrefsOpen}
      />
    </>
  );
}

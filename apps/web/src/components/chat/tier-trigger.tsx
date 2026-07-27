import { useState, type ReactNode } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@deco/ui/components/drawer.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
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
import { useT, type TFunction } from "@/i18n/use-t.ts";
import type { ChatTier } from "@decocms/shared/organization/schema";
import {
  resolveTierSubtitle,
  useAgentMode,
  useChatTier,
  useSetChatTier,
  type AgentMode,
} from "./use-agent-mode";
import { useChatPrefs, useOptionalChatTask } from "./context";
import {
  useEffectiveSimpleMode,
  useUpdateUserModelPreferences,
  useUserModelPreferencesQuery,
} from "@/hooks/use-user-model-preferences";
import { useSimpleMode } from "@/hooks/use-organization-settings";
import {
  useAiProviderKeys,
  useAutoSimpleModeDefaults,
} from "@/hooks/collections/use-ai-providers";
import { TierModelOverridePicker } from "./tier-model-override-row";
import { useAgentOptionAvailability } from "./use-agent-availability";
import {
  type AgentOption,
  preferredLocalAgentOption,
} from "./pills/agent-options";
import { ClaudeCodeIcon, CodexIcon, localHarnessBrand } from "./agent-icons";

const TIER_ORDER: ChatTier[] = ["fast", "smart", "thinking"];

function getTierLabels(t: TFunction): Record<ChatTier, string> {
  return {
    fast: t("chat.tierTrigger.tierFast"),
    smart: t("chat.tierTrigger.tierSmart"),
    thinking: t("chat.tierTrigger.tierThinking"),
  };
}

/** One selectable row in the popover — a concrete (runtime, tier) choice. */
interface TierRow {
  key: string;
  icon?: ReactNode;
  title: string;
  subtitle?: string | null;
  active: boolean;
  onSelect: () => void;
  /**
   * When set, a cog appears on the row (on hover for pointer devices, always
   * on touch) that opens a small popover with this content to the side —
   * without closing the tier popover itself. Receives a callback to close
   * just that nested popover (e.g. once a pick is made).
   */
  modelOverride?: (closeOverride: () => void) => ReactNode;
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
}: PureProps) {
  const t = useT();
  const tierLabels = getTierLabels(t);
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
      <PopoverContent
        align="end"
        className="p-1 w-64"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
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
                <div
                  key={row.key}
                  className="group/tier-row relative flex items-stretch rounded-md hover:bg-muted"
                >
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={
                      group.label ? `${group.label} ${row.title}` : row.title
                    }
                    onClick={() => handleSelect(row)}
                    className={cn(
                      "flex flex-1 min-w-0 items-start gap-2 px-2 py-1.5 text-left",
                      // Reserve room for the cog on touch (always visible,
                      // no hover to overlay transiently); hover-capable
                      // devices get the full row width back since the cog
                      // only floats over it while actually hovered.
                      row.modelOverride && "pr-7 [@media(hover:hover)]:pr-2",
                    )}
                  >
                    {row.icon && (
                      <span className="shrink-0 text-muted-foreground mt-0.5">
                        {row.icon}
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
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
                  {row.modelOverride && (
                    <TierRowModelOverride
                      label={row.title}
                      render={row.modelOverride}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Cog affordance on a tier row that opens that row's `modelOverride` content
 * without touching the tier popover's own open state. Hidden until the row
 * is hovered/focused on pointer devices; touch has no hover to reveal it, so
 * it stays visible there (and stays visible on any device while its own
 * overlay is open, so mousing toward the content doesn't make the trigger
 * vanish). Desktop anchors a side popover next to the row; a side popover
 * has nowhere to go on a narrow phone screen, so mobile opens a bottom
 * drawer instead — the same mobile pattern the full model picker already
 * uses elsewhere.
 */
function TierRowModelOverride({
  label,
  render,
}: {
  label: string;
  render: (closeOverride: () => void) => ReactNode;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const cogButton = (
    <button
      type="button"
      aria-label={t("chat.modelPreferences.customizeModel", { tier: label })}
      className={cn(
        // Absolutely positioned so it never eats into the row's flex layout
        // width (which would otherwise force the title/subtitle to truncate
        // even at rest) — it only ever floats on top.
        "absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center",
        "size-6 rounded-md bg-background border border-border/60 shadow-sm",
        "text-muted-foreground hover:text-foreground",
        "opacity-100 [@media(hover:hover)]:opacity-0",
        "[@media(hover:hover)]:group-hover/tier-row:opacity-100",
        "[@media(hover:hover)]:group-focus-within/tier-row:opacity-100",
        open && "opacity-100",
      )}
    >
      <Settings01 size={14} />
    </button>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{cogButton}</DrawerTrigger>
        <DrawerContent className="p-0 flex flex-col max-h-[95vh]">
          <DrawerTitle className="sr-only">
            {t("chat.modelPreferences.customizeModel", { tier: label })}
          </DrawerTitle>
          {open && render(close)}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{cogButton}</PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        collisionPadding={12}
        className="w-[min(22rem,calc(100vw-2rem))] p-0 overflow-hidden"
      >
        {open && render(close)}
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
function useTierModelNames(
  autoDefaults: ReturnType<typeof useAutoSimpleModeDefaults>,
): Record<ChatTier, string | undefined> {
  const effective = useEffectiveSimpleMode();

  const nameFor = (tier: ChatTier) => {
    const slot = effective.tiers[tier];
    if (slot) return slot.title ?? slot.modelId;
    return autoDefaults.chat[tier]?.title;
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
          aria-pressed={o.active}
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
  t: TFunction;
}): TierGroup {
  return {
    key: params.key,
    label: params.label,
    rows: TIER_ORDER.map((t) => ({
      key: `${params.key}-${t}`,
      icon: params.icon,
      title: params.tierLabels[t],
      subtitle: resolveTierSubtitle(params.mode, t, params.t),
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
  // Cloud rows only: org config + this user's overrides, wired into each
  // row's cog popover below.
  const org = useSimpleMode();
  const keys = useAiProviderKeys();
  // Mirrors the server's default-pick across the org's first few keys (not
  // just the first one) so an org with more than one provider — e.g. a
  // self-hosted/local key alongside a cloud one — shows and edits whichever
  // key the backend would actually pick for a tier, not an arbitrary key.
  const autoDefaults = useAutoSimpleModeDefaults(keys);
  // Per-tier model name (user override → org slot → auto-pick) shown as each
  // cloud row's subtitle.
  const tierModelNames = useTierModelNames(autoDefaults);
  const { data: userModelPrefs = { tiers: {} }, error: userModelPrefsError } =
    useUserModelPreferencesQuery();
  const updateUserModelPreferences = useUpdateUserModelPreferences();

  const tierLabels = getTierLabels(t);

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
          t,
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
          t,
        }),
      );
    }
    groups = built;
  } else {
    groups = [
      {
        key: "cloud",
        rows: TIER_ORDER.map((tierOption) => {
          const modelName = tierModelNames[tierOption];
          const userSlot = userModelPrefs.tiers[tierOption];
          return {
            key: `cloud-${tierOption}`,
            icon: tierIconFor(tierOption),
            title: tierLabels[tierOption],
            // Show the concrete model backing this tier; fall back to the
            // intent blurb before the org config has loaded.
            subtitle:
              modelName ??
              resolveTierSubtitle("cloud-decopilot", tierOption, t),
            active: tier === tierOption,
            onSelect: () => setTier(tierOption),
            // Local CLI tiers are fixed per harness, so only cloud rows get a
            // personal-override cog.
            modelOverride: (closeOverride: () => void) => (
              <>
                {/* A failed read would otherwise render every tier as "using
                    organization default" here too — see useUserModelPreferencesQuery. */}
                {userModelPrefsError && (
                  <div className="text-xs text-destructive p-3 pb-0">
                    {t("chat.modelPreferences.loadFailed")}
                  </div>
                )}
                <TierModelOverridePicker
                  // Remount when the effective slot changes so the picker's
                  // "browsing which provider key" state can't go stale.
                  key={`${tierOption}:${userSlot?.keyId ?? "org"}:${userSlot?.modelId ?? ""}`}
                  tier={tierOption}
                  orgSlot={org.tiers[tierOption]}
                  userSlot={userSlot}
                  autoSlot={autoDefaults.chat[tierOption]}
                  onClose={closeOverride}
                  onPick={(slot) =>
                    updateUserModelPreferences.mutate({
                      tier: tierOption,
                      slot,
                    })
                  }
                  onReset={() =>
                    updateUserModelPreferences.mutate({
                      tier: tierOption,
                      slot: null,
                    })
                  }
                />
              </>
            ),
          };
        }),
      },
    ];
  }

  const localBrand = isLocal ? localHarnessBrand(pendingHarnessId) : null;
  const LocalBrandIcon = localBrand?.Icon;

  return (
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
    />
  );
}

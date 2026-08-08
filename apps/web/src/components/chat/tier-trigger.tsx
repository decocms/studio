import { useState, type ReactNode } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@decocms/ui/components/drawer.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Atom01,
  ChevronDown,
  Check,
  Lightning01,
  Settings01,
  Stars01,
} from "@untitledui/icons";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import type { ChatTier } from "@decocms/shared/organization/schema";
import { useChatPrefs } from "./context";
import {
  useEffectiveSimpleMode,
  useUpdateUserModelPreferences,
  useUserModelPreferencesQuery,
} from "@/hooks/use-user-model-preferences";
import { useSimpleMode } from "@/hooks/use-organization-settings";
import {
  useHostedAiProviderKeys,
  useAutoSimpleModeDefaults,
} from "@/hooks/collections/use-ai-providers";
import { TierModelOverridePicker } from "./tier-model-override-row";

const TIER_ORDER: ChatTier[] = ["fast", "smart", "thinking"];

function getTierLabels(t: TFunction): Record<ChatTier, string> {
  return {
    fast: t("chat.tierTrigger.tierFast"),
    smart: t("chat.tierTrigger.tierSmart"),
    thinking: t("chat.tierTrigger.tierThinking"),
  };
}

const TIER_DESCRIPTION_KEYS: Record<ChatTier, Parameters<TFunction>[0]> = {
  fast: "chat.agentModels.quickerResponses",
  smart: "chat.agentModels.balancedQuality",
  thinking: "chat.agentModels.deeperReasoning",
};

/** One selectable tier row in the hosted Decopilot popover. */
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

/** A cluster of hosted tier rows. */
interface TierGroup {
  key: string;
  rows: TierRow[];
}

interface PureProps {
  /** Active tier — drives the closed-pill label. */
  tier: ChatTier;
  /** Optional glyph rendered on the closed pill next to the tier label. */
  pillIcon?: ReactNode;
  /** Tier options grouped for rendering. */
  groups: TierGroup[];
}

/**
 * Pure variant — no external dependencies (no context, no queries).
 * Owns only local UI state (the popover open flag) so tests can mount
 * it without mocking the chat context. Closed pill shows the icon
 * (when provided) + tier label. Selecting a row runs its `onSelect` and closes
 * the popover.
 */
export function TierTriggerPure({ tier, pillIcon, groups }: PureProps) {
  const t = useT();
  const tierLabels = getTierLabels(t);
  const [open, setOpen] = useState(false);
  const handleSelect = (row: TierRow) => {
    row.onSelect();
    setOpen(false);
  };
  const pillLabel = tierLabels[tier];

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
                aria-label={pillLabel}
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
        <TooltipContent>{pillLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="p-1 w-64"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div role="menu" className="flex flex-col">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col">
              {group.rows.map((row) => (
                <div
                  key={row.key}
                  className="group/tier-row relative flex items-stretch rounded-md hover:bg-muted"
                >
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={row.title}
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
 * Per-tier intent glyph (Lightning / Stars / Atom) used by hosted Decopilot.
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

/**
 * Hosted Decopilot tier picker used by `Chat.Input`. Native coding agents own
 * their full-screen xterm surface and never render the hosted composer.
 */
export function TierTrigger() {
  const t = useT();
  const { simpleModeTier: tier, setSimpleModeTier: setTier } = useChatPrefs();
  const org = useSimpleMode();
  const keys = useHostedAiProviderKeys();
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

  const groups: TierGroup[] = [
    {
      key: "decopilot",
      rows: TIER_ORDER.map((tierOption) => {
        const modelName = tierModelNames[tierOption];
        const userSlot = userModelPrefs.tiers[tierOption];
        return {
          key: `decopilot-${tierOption}`,
          icon: tierIconFor(tierOption),
          title: tierLabels[tierOption],
          subtitle: modelName ?? t(TIER_DESCRIPTION_KEYS[tierOption]),
          active: tier === tierOption,
          onSelect: () => setTier(tierOption),
          modelOverride: (closeOverride: () => void) => (
            <>
              {userModelPrefsError && (
                <div className="text-xs text-destructive p-3 pb-0">
                  {t("chat.modelPreferences.loadFailed")}
                </div>
              )}
              <TierModelOverridePicker
                key={`${tierOption}:${userSlot?.keyId ?? "org"}:${userSlot?.modelId ?? ""}`}
                tier={tierOption}
                orgSlot={org.tiers[tierOption]}
                userSlot={userSlot}
                autoSlot={autoDefaults.chat[tierOption]}
                onClose={closeOverride}
                onPick={(slot) =>
                  updateUserModelPreferences.mutate({ tier: tierOption, slot })
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

  return (
    <TierTriggerPure tier={tier} pillIcon={tierIconFor(tier)} groups={groups} />
  );
}

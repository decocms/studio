/**
 * HeaderTabButton — a tab in the agent-shell header tab bar.
 *
 * Every tab shows its icon at all sizes; the text label drops out per
 * `labelCollapse`, leaving an icon-only button. That decision is a CONTAINER
 * query against the enclosing PanelHeader, not a viewport media query — the
 * button cares how wide its panel is, not how wide the screen is.
 *
 * The active tab gets the accent background; inactive tabs are muted.
 *
 * Every button is wrapped in a Tooltip so the title stays discoverable in both
 * states — and, once the label is gone, so an icon-only tab is identifiable at
 * all. Tabs whose icon resolves to the generic fallback (see resolve-tab-icon)
 * are otherwise indistinguishable from one another.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { TabIcon } from "./resolve-tab-icon";
import { TabIconGlyph } from "./tab-icon-glyph";

/** Static class per tier — Tailwind only sees literal strings, so these can't
 *  be built by interpolation. Queries `@container/panel-header` (PanelHeader),
 *  NOT the viewport: these buttons live in a single panel, so panel width is
 *  the only measure of the room they actually have. Outside a PanelHeader no
 *  container matches and the label simply stays — the safe direction. */
const LABEL_HIDDEN_BELOW = {
  sooner: "@max-3xl/panel-header:hidden",
  later: "@max-xl/panel-header:hidden",
} as const;

export function HeaderTabButton({
  title,
  icon,
  active,
  onClick,
  disabled = false,
  locked = false,
  className,
  testId,
  dataTour,
  tooltip,
  labelCollapse = "later",
}: {
  title: string;
  icon: TabIcon;
  active: boolean;
  onClick: () => void;
  /** Optional test hook (data-testid). */
  testId?: string;
  /** Optional anchor for the CMS onboarding tour (data-tour). */
  dataTour?: string;
  /** Disables the button and dims it (e.g. every tab while the org still
   *  needs runtime setup — the view is a genuine dead-end). */
  disabled?: boolean;
  /** Blocks interaction WITHOUT dimming — for the active tab when clicking it
   *  would close the only visible panel. It must still read as the selected
   *  tab (full-opacity accent), just not respond to clicks. */
  locked?: boolean;
  /** Extra classes merged onto the base metrics — lets non-tab consumers
   *  (the Chat toggle) tweak height / drag behaviour while staying pixel-
   *  identical to the tabs. */
  className?: string;
  /** Tooltip copy, when it must differ from the label — e.g. a toggle whose
   *  hover text describes the *next* action ("Exit editor") rather than the
   *  button's name. Defaults to `title`. Pass this instead of wrapping the
   *  button in your own Tooltip, which would nest two of them. */
  tooltip?: string;
  /** How soon the label is dropped as the PANEL HEADER narrows, leaving icon +
   *  tooltip. Labels always go before the centered address bar does (which
   *  hides at 384px), because shedding ~40px per button is what buys the
   *  centre its room — the same degradation order headerLayout documents.
   *  - `sooner` (< 768px) — Chat and the system tabs (Preview, Code, Library,
   *    Tasks). Fixed, distinctive icons, so they read fine bare.
   *  - `later` (< 576px, default) — dynamic tabs (files, pinned views, expanded
   *    tools). Their icon can resolve to the generic fallback, so several open
   *    at once would be indistinguishable; they hold their text longest. */
  labelCollapse?: "sooner" | "later";
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-tour={dataTour}
      aria-pressed={active}
      aria-disabled={locked || undefined}
      aria-label={title}
      className={cn(
        "shrink-0 flex items-center gap-1.5 h-7 rounded-md px-2",
        "[transition:background-color_180ms_ease,color_180ms_ease]",
        "disabled:opacity-40 disabled:pointer-events-none",
        locked && "pointer-events-none",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
        className,
      )}
    >
      <span className="flex size-5 items-center justify-center shrink-0">
        <TabIconGlyph icon={icon} />
      </span>
      <span
        className={cn(
          LABEL_HIDDEN_BELOW[labelCollapse],
          "whitespace-nowrap text-sm font-medium leading-none",
        )}
      >
        {title}
      </span>
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{tooltip ?? title}</TooltipContent>
    </Tooltip>
  );
}

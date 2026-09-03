/** HeaderTabButton — a tab in the agent-shell header bar. Every tab shows its
 *  icon; the label drops out per `labelCollapse`, on a CONTAINER query against
 *  the enclosing PanelHeader rather than the viewport, because the button cares
 *  how wide its panel is. Active gets the accent background, inactive is muted,
 *  and that skin — colours, transition, focus ring — comes from
 *  `panelButtonChrome`, shared with the icon buttons beside it.
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
import { panelButtonChrome } from "@/components/toolbar-icon-button";
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
  tooltip,
  labelCollapse = "later",
}: {
  title: string;
  icon: TabIcon;
  active: boolean;
  onClick: () => void;
  /** Optional test hook (data-testid). */
  testId?: string;
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
      aria-pressed={active}
      aria-disabled={locked || undefined}
      aria-label={title}
      className={cn(
        "shrink-0 flex items-center gap-1.5 h-7 rounded-md px-2",
        panelButtonChrome(active),
        "disabled:opacity-40 disabled:pointer-events-none",
        locked && "pointer-events-none",
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

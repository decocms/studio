/**
 * HeaderTabButton — a tab in the agent-shell header tab bar.
 *
 * Both active and inactive tabs always show icon + label. The active
 * tab gets the accent background; inactive tabs are muted.
 *
 * Every button is wrapped in a Tooltip showing the tab title so the
 * title is discoverable on hover in both states.
 */

import { cn } from "@deco/ui/lib/utils.ts";
import type { TabIcon } from "./resolve-tab-icon";
import { TabIconGlyph } from "./tab-icon-glyph";

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
}) {
  return (
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
      <span className="max-md:hidden whitespace-nowrap text-sm font-medium leading-none">
        {title}
      </span>
    </button>
  );
}

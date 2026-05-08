/**
 * HeaderTabButton — a tab in the agent-shell header tab bar.
 *
 * Both active and inactive tabs always show icon + label. The active
 * tab gets the accent background; inactive tabs are muted.
 *
 * Every button is wrapped in a Tooltip showing the tab title so the
 * title is discoverable on hover in both states.
 */

import { Package } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { TabIcon } from "./resolve-tab-icon";

export function HeaderTabButton({
  title,
  icon,
  active,
  onClick,
}: {
  title: string;
  icon: TabIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={title}
      className={cn(
        "shrink-0 flex items-center gap-1.5 h-8 rounded-md px-2",
        "[transition:background-color_180ms_ease,color_180ms_ease]",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
      )}
    >
      <span className="flex size-5 items-center justify-center shrink-0">
        <Icon icon={icon} />
      </span>
      <span className="whitespace-nowrap text-sm font-medium leading-none">
        {title}
      </span>
    </button>
  );
}

function Icon({ icon }: { icon: TabIcon }) {
  if (icon.kind === "component") {
    const { Component } = icon;
    return <Component className="size-4" />;
  }
  if (icon.kind === "url") {
    return (
      <img src={icon.src} alt="" className="size-4 rounded-sm object-cover" />
    );
  }
  return <Package className="size-4" />;
}

/** The ONE sidebar row, and the one preset of it that every "way out" uses.
 *  Every list in every sidebar — org destinations, a project's views, Settings,
 *  the settings tree, sign out — goes through `SidebarNavRow`, so a row cannot
 *  pick up a different height, gap or accessible name by being rendered
 *  somewhere else.
 *  It exists for the ACCESSIBLE NAME as much as for the deduplication.
 *  `sidebarMenuButtonVariants` ends with
 *  `group-data-[state=collapsed]/sidebar:[&>span:last-child]:hidden`, and
 *  Tailwind's `hidden` is `display: none`, which drops the label out of the
 *  accessibility tree entirely. Collapsed, every row was therefore an icon plus
 *  an unrendered span: no name at all, announced as a bare "link" or "button".
 *  The tooltip does not save it — Radix Tooltip contributes `aria-describedby`,
 *  a DESCRIPTION, which never substitutes for a name. So this always sets
 *  `aria-label`, in both states, for every row that goes through it.
 *  `link` and `onSelect` are deliberately NOT a discriminated union: the
 *  Settings row computes a `LinkProps | undefined` off the scope and passes a
 *  handler either way, which fits neither branch of a union but is exactly one
 *  row. `link` present means anchor; absent means button. */

import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowLeft } from "@untitledui/icons";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";

interface SidebarNavRowProps {
  icon: ReactNode;
  /** The visible text, and the accessible name unless `ariaLabel` overrides. */
  label: string;
  isActive?: boolean;
  /** Present = a real anchor, so middle-click and open-in-new-tab work. Absent
   *  = a button, for destinations whose target is only knowable on click. */
  link?: LinkProps;
  onSelect?: () => void;
  /** Only when the name must differ from the visible text. */
  ariaLabel?: string;
  className?: string;
  /** `data-tour` anchor, for the rows a product tour highlights. */
  dataTour?: string;
  /** Rows nested under this one, rendered inside its `<li>` after the button. */
  children?: ReactNode;
}

export function SidebarNavRow({
  icon,
  label,
  isActive = false,
  link,
  onSelect,
  ariaLabel,
  className,
  dataTour,
  children,
}: SidebarNavRowProps) {
  const isCollapsed = useSidebarCollapsed();
  const name = ariaLabel ?? label;

  /** Expanded, the label is right there — a tooltip repeating it is noise. */
  const shared = {
    isActive,
    tooltip: isCollapsed ? name : undefined,
    className,
    "data-tour": dataTour,
  };

  /** The label span MUST stay the LAST element child: the rail hides exactly
   *  `span:last-child`. Appending a trailing badge or count here would make the
   *  badge the hidden node and leave the label rendered at icon width, breaking
   *  every row at once — put such an element BEFORE the label, the way
   *  `footer/inbox.tsx` places its unread dot. */
  const body = (
    <>
      {icon}
      <span className="truncate">{label}</span>
    </>
  );

  if (link) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild {...shared}>
          <Link
            {...link}
            aria-label={name}
            aria-current={isActive ? "page" : undefined}
            onClick={onSelect}
          >
            {body}
          </Link>
        </SidebarMenuButton>
        {children}
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        {...shared}
        aria-label={name}
        aria-current={isActive ? "page" : undefined}
        onClick={onSelect}
      >
        {body}
      </SidebarMenuButton>
      {children}
    </SidebarMenuItem>
  );
}

/** The one "← Back to X" row, for every place that is somewhere you can leave.
 *  Two of these exist — out of a project, and out of the settings tree — and
 *  they are the same affordance, so they are one component: a caller supplies
 *  the label and either a `link` (a real anchor, when the destination is
 *  knowable) or an `onSelect` (when leaving is a decision rather than a URL).
 *  It owns its band, since the slot holding it may render nothing. */
export function SidebarBackRow({
  label,
  link,
  onSelect,
}: {
  label: string;
  link?: LinkProps;
  onSelect?: () => void;
}) {
  return (
    <div className="-mx-2 border-b border-sidebar-border px-2 py-2">
      <SidebarMenu className="shrink-0">
        <SidebarNavRow
          icon={<ArrowLeft size={16} />}
          label={label}
          className="text-sidebar-foreground/70"
          link={link}
          onSelect={onSelect}
        />
      </SidebarMenu>
    </div>
  );
}

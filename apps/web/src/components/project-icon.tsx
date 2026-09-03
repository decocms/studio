/**
 * A project's mark, wherever a project is NAMED — a sidebar row, a picker row,
 * a filter chip, a property.
 *
 * It takes no `className` on purpose. Every call site that could set one set a
 * different one, and the mark ended up 14px here, 16px there and 20px in the
 * command palette, all around a glyph whose size no `className` can reach —
 * so "the size of a project mark" was a decision made five times. It is made
 * once, here, at the step the sidebar already used: a 16px box around a 12px
 * glyph. `shrink-0` is already baked into `AgentAvatar`, so there is nothing
 * left for a caller to pass.
 *
 * NOT portable, and deliberately not reproduced: the sidebar paints its glyphs
 * at 60% opacity until hover (`[&_svg]:opacity-60` on `SidebarMenuButton`,
 * packages/ui). That is nav-rail chrome — a popover row is not a nav rail, and
 * forcing it on would make project rows brighter than every destination beside
 * them.
 */

import { AgentAvatar } from "@/components/agent-icon";

export function ProjectIcon({
  icon,
  name,
}: {
  icon: string | null | undefined;
  name: string;
}) {
  return <AgentAvatar icon={icon} name={name} size="2xs" />;
}

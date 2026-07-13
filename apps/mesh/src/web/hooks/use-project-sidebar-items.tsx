import type { SidebarSection } from "@/web/components/sidebar/types";

/**
 * Sidebar sections rendered above the thread list. Currently empty — the
 * collapsed rail's new-thread button lives inside the thread list itself
 * (see task-groups-list), alongside the collapse toggle and thread icons.
 */
export function useProjectSidebarItems(): SidebarSection[] {
  return [];
}

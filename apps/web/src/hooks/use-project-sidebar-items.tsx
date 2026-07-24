import type { SidebarSection } from "@/components/sidebar/types";

/**
 * Sidebar sections rendered above the thread list. Currently empty — the
 * collapsed rail's new-thread button lives inside the thread list itself
 * (see task-groups-list), alongside the collapse toggle and thread icons.
 *
 * The task board ("Tasks") now lives in the top toolbar next to Chat and
 * Library (see `TasksTab`), not here.
 */
export function useProjectSidebarItems(): SidebarSection[] {
  return [];
}

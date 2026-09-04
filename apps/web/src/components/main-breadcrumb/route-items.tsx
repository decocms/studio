import { resolvePanelNavigationSearch } from "@/layouts/main-panel-tabs/panel-navigation-search";
import type { OrganizationData } from "@/sdk/context/project-context";
import { Home02 } from "@untitledui/icons";
import type { MainBreadcrumbNavigableItem } from ".";

/**
 * Canonical scope links used by route-owned breadcrumbs.
 *
 * Keeping these builders beside the presentation component makes the link
 * contract explicit and reusable without teaching `Main` about organizations,
 * projects, router params, or thread state.
 */
export function organizationMainBreadcrumbItem(
  org: OrganizationData,
  homeLabel: string,
): MainBreadcrumbNavigableItem {
  return {
    id: `organization:${org.id}`,
    label: homeLabel.trim() || org.name.trim() || org.slug,
    icon: <Home02 size={14} />,
    link: {
      to: "/$org/home",
      params: { org: org.slug },
    },
  };
}

/**
 * A project workspace is its own home, so its scope control is the same Home
 * affordance the organization uses rather than the project's avatar: inside
 * `/$org/projects/$agentId` the sidebar already names the project, and the mark
 * repeated it while reading like an entity chip instead of a way back. The
 * label still supplies the accessible name, so the icon stays decorative.
 */
export function projectMainBreadcrumbItem(
  orgSlug: string,
  agent: { id: string; title: string },
  fallbackLabel: string,
): MainBreadcrumbNavigableItem {
  const label = agent.title.trim() || fallbackLabel;
  return {
    id: `project:${agent.id}`,
    label,
    icon: <Home02 size={14} />,
    link: {
      to: "/$org/projects/$agentId",
      params: { org: orgSlug, agentId: agent.id },
      search: (previous) =>
        resolvePanelNavigationSearch({
          previous,
          destination: "agent",
        }),
    },
  };
}

export function connectionMainBreadcrumbItem(
  orgSlug: string,
  appSlug: string,
  connection: { id: string; title: string },
  tab?: string,
): MainBreadcrumbNavigableItem {
  return {
    id: `connection:${connection.id}`,
    label: connection.title.trim() || appSlug,
    link: {
      to: "/$org/settings/connections/$appSlug",
      params: { org: orgSlug, appSlug },
      ...(tab ? { search: { tab } } : {}),
    },
  };
}

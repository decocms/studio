import { useProjectContext } from "@decocms/mesh-sdk";
import type {
  NavigationSidebarItem,
  SidebarSection,
} from "@/web/components/sidebar/types";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Dataflow03, Home01, LayoutLeft } from "@untitledui/icons";
import { getIconComponent, parseIconString } from "../components/agent-icon";
import { useTasksPanel } from "@/web/contexts/panel-context";
import { pluginRootSidebarItems, pluginSidebarGroups } from "../index.tsx";
import { PLUGIN_ID as WORKFLOWS_PLUGIN_ID } from "mesh-plugin-workflows/shared";

export function useProjectSidebarItems(): SidebarSection[] {
  const { org: orgContext } = useProjectContext();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const [, setTasksOpen] = useTasksPanel();
  const org = orgContext.slug;
  const currentProject = useProjectContext().project;

  // The virtual MCP ID for this project
  const virtualMcpId = currentProject.id;

  const pathname = routerState.location.pathname;

  // All projects (including org-admin) use project-level enabledPlugins
  const enabledPlugins = currentProject.enabledPlugins ?? [];

  // Pinned views from project UI settings
  const pinnedViews =
    (
      currentProject.ui as
        | {
            pinnedViews?: Array<{
              connectionId: string;
              toolName: string;
              label: string;
              icon: string | null;
            }> | null;
          }
        | null
        | undefined
    )?.pinnedViews ?? [];

  // Filter plugins to only show enabled ones
  const enabledPluginItems = pluginRootSidebarItems.filter((item) =>
    enabledPlugins.includes(item.pluginId),
  );

  // Extract the virtualMcpId from the URL when inside an agent route.
  // The sidebar is rendered outside VirtualMCPProvider, so useProjectContext
  // always returns the org-level project. We parse the URL to detect agent context.
  const orgPrefix = `/${org}/`;
  const afterOrg = pathname.startsWith(orgPrefix)
    ? pathname.slice(orgPrefix.length)
    : "";
  const urlSegments = afterOrg.split("/").filter(Boolean);
  const knownOrgRoutes = new Set(["settings", "agents", "store", "plugins"]);
  const firstSegment = urlSegments[0] ?? "";
  const isInsideAgent =
    firstSegment !== "" && !knownOrgRoutes.has(firstSegment);
  const agentVirtualMcpId = isInsideAgent ? firstSegment : virtualMcpId;

  const basePath = `/${org}/${agentVirtualMcpId}`;

  const isActiveRoute = (path: string) =>
    pathname.startsWith(`${basePath}/${path}`);

  // Plugin items mapped to navigation items (flat items)
  // Plugins are scoped to the virtual MCP
  const pluginItems: NavigationSidebarItem[] = enabledPluginItems.map(
    (item) => ({
      key: item.pluginId,
      label: item.label,
      icon: item.icon,
      isActive: isActiveRoute(item.pluginId),
      onClick: () =>
        navigate({
          to: "/$org/$virtualMcpId/$pluginId",
          params: {
            org,
            virtualMcpId,
            pluginId: item.pluginId,
          },
        }),
    }),
  );

  // Filter plugin groups to only show enabled ones
  const enabledPluginGroups = pluginSidebarGroups.filter((group) =>
    enabledPlugins.includes(group.pluginId),
  );

  // Plugin groups mapped to sidebar sections
  const pluginGroupSections: SidebarSection[] = enabledPluginGroups.map(
    (group) => ({
      type: "group" as const,
      group: {
        id: `${group.pluginId}-${group.id}`,
        label: group.label,
        items: group.items.map((item, index) => ({
          key: `${group.pluginId}-${group.id}-${index}`,
          label: item.label,
          icon: item.icon,
          isActive: isActiveRoute(group.pluginId),
          onClick: () =>
            navigate({
              to: "/$org/$virtualMcpId/$pluginId",
              params: {
                org,
                virtualMcpId,
                pluginId: group.pluginId,
              },
            }),
        })),
        defaultExpanded: group.defaultExpanded ?? true,
      },
    }),
  );

  // Build pinned views sidebar items
  // Pinned views are scoped to the virtual MCP
  const pinnedViewItems: NavigationSidebarItem[] = pinnedViews.map((view) => {
    const parsed = parseIconString(view.icon);
    const IconComp =
      parsed.type === "icon" ? getIconComponent(parsed.name) : null;
    return {
      key: `app-${view.connectionId}-${view.toolName}`,
      label: view.label || view.toolName,
      icon: IconComp ? (
        <IconComp size={16} className="text-muted-foreground" />
      ) : parsed.type === "url" ? (
        <img src={parsed.url} alt="" className="size-4 rounded" />
      ) : (
        <LayoutLeft size={16} className="text-muted-foreground" />
      ),
      isActive: isActiveRoute(
        `apps/${view.connectionId}/${encodeURIComponent(view.toolName)}`,
      ),
      onClick: () =>
        navigate({
          to: "/$org/$virtualMcpId/apps/$connectionId/$toolName",
          params: {
            org,
            virtualMcpId,
            connectionId: view.connectionId,
            toolName: view.toolName,
          },
        }),
    };
  });

  const pinnedViewsSection: SidebarSection | null =
    pinnedViewItems.length > 0
      ? {
          type: "group",
          group: {
            id: "apps",
            label: "Apps",
            items: pinnedViewItems,
            defaultExpanded: true,
          },
        }
      : null;

  const homeItem: NavigationSidebarItem = {
    key: "home",
    label: "Home",
    icon: <Home01 className="size-4!" />,
    isActive: pathname === `/${org}` || pathname === `/${org}/`,
    onClick: () => {
      setTasksOpen(false);
      navigate({ to: "/$org", params: { org } });
    },
  };

  const isWorkflowsEnabled = enabledPlugins.includes(WORKFLOWS_PLUGIN_ID);

  const workflowsItem: NavigationSidebarItem = {
    key: "workflows",
    label: "Workflows",
    icon: <Dataflow03 className="size-4!" />,
    isActive: pathname.startsWith(`/${org}/settings/workflows`),
    onClick: () =>
      navigate({
        to: "/$org/settings/workflows",
        params: { org },
      }),
  };

  const topItems: NavigationSidebarItem[] = [homeItem];
  if (isInsideAgent && isWorkflowsEnabled) {
    topItems.push(workflowsItem);
  }

  const sections: SidebarSection[] = [{ type: "items", items: topItems }];

  // Add flat plugin items if any
  if (pluginItems.length > 0) {
    sections.push({ type: "items", items: pluginItems });
  }

  // Add plugin groups
  if (pluginGroupSections.length > 0) {
    sections.push(...pluginGroupSections);
  }

  // Add pinned views
  if (pinnedViewsSection) {
    sections.push(pinnedViewsSection);
  }

  return sections;
}

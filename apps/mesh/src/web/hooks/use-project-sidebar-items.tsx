import { useProjectContext, useIsOrgAdmin } from "@decocms/mesh-sdk";
import type {
  NavigationSidebarItem,
  SidebarSection,
} from "@/web/components/sidebar/types";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BarChart10,
  CheckDone01,
  Container,
  Dataflow03,
  Folder,
  Home02,
  LayoutLeft,
  RefreshCcw01,
  Settings01,
  Users03,
} from "@untitledui/icons";
import { pluginRootSidebarItems, pluginSidebarGroups } from "../index.tsx";
import { usePreferences } from "./use-preferences.ts";

export function useProjectSidebarItems(): SidebarSection[] {
  const { org: orgContext } = useProjectContext();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const [preferences] = usePreferences();
  const org = orgContext.slug;
  const isOrgAdminProject = useIsOrgAdmin();
  const currentProject = useProjectContext().project;

  // The virtual MCP ID for this project (used in /$org/projects/$virtualMcpId routes)
  const virtualMcpId = currentProject.id;

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

  const pathname = routerState.location.pathname;

  // For org-admin, base path is /$org; for projects, /$org/projects/$virtualMcpId
  const basePath = isOrgAdminProject
    ? `/${org}`
    : `/${org}/projects/${virtualMcpId}`;

  const isOnHome = pathname === basePath || pathname === `${basePath}/`;

  const isActiveRoute = (path: string) =>
    pathname.startsWith(`${basePath}/${path}`);

  // Common items for all projects
  const homeItem: NavigationSidebarItem = {
    key: "home",
    label: "Home",
    icon: <Home02 />,
    isActive: isOnHome,
    onClick: () => {
      if (isOnHome) {
        window.dispatchEvent(new CustomEvent("reset-home-view"));
      } else {
        navigate({
          to: "/$org",
          params: { org },
        });
      }
    },
  };

  // Org-admin specific items - flat list matching Figma design
  const tasksItem: NavigationSidebarItem = {
    key: "tasks",
    label: "Tasks",
    icon: <CheckDone01 />,
    isActive: isActiveRoute("tasks"),
    onClick: () =>
      navigate({
        to: "/$org/tasks",
        params: { org },
      }),
  };

  const connectionsItem: NavigationSidebarItem = {
    key: "mcps",
    label: "Connections",
    icon: <Container />,
    isActive: isActiveRoute("mcps"),
    onClick: () =>
      navigate({
        to: "/$org/mcps",
        params: { org },
      }),
  };

  const projectsItem: NavigationSidebarItem = {
    key: "projects",
    label: "Projects",
    icon: <Folder />,
    isActive: isActiveRoute("projects"),
    onClick: () =>
      navigate({
        to: "/$org/projects",
        params: { org },
      }),
  };

  const agentsItem: NavigationSidebarItem = {
    key: "agents",
    label: "Agents",
    icon: <Users03 />,
    isActive: isActiveRoute("agents"),
    onClick: () =>
      navigate({
        to: "/$org/agents",
        params: { org },
      }),
  };

  const automationsItem: NavigationSidebarItem = {
    key: "automations",
    label: "Automations",
    icon: <RefreshCcw01 />,
    isActive: isActiveRoute("automations"),
    onClick: () =>
      navigate({
        to: "/$org/automations",
        params: { org },
      }),
  };

  const monitorItem: NavigationSidebarItem = {
    key: "monitoring",
    label: "Monitor",
    icon: <BarChart10 />,
    isActive: isActiveRoute("monitoring"),
    onClick: () =>
      navigate({
        to: "/$org/monitoring",
        params: { org },
      }),
  };

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
          to: "/$org/projects/$virtualMcpId/$pluginId",
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
              to: "/$org/projects/$virtualMcpId/$pluginId",
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
  const pinnedViewItems: NavigationSidebarItem[] = pinnedViews.map((view) => ({
    key: `app-${view.connectionId}-${view.toolName}`,
    label: view.label || view.toolName,
    icon: view.icon ? (
      <img src={view.icon} alt="" className="size-4 rounded" />
    ) : (
      <LayoutLeft />
    ),
    isActive: isActiveRoute(
      `apps/${view.connectionId}/${encodeURIComponent(view.toolName)}`,
    ),
    onClick: () =>
      navigate({
        to: "/$org/projects/$virtualMcpId/apps/$connectionId/$toolName",
        params: {
          org,
          virtualMcpId,
          connectionId: view.connectionId,
          toolName: view.toolName,
        },
      }),
  }));

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

  if (isOrgAdminProject) {
    // Org-admin sidebar layout:
    // - Home, Tasks (if enabled), Projects (if enabled) (top-level)
    // - Build group: Agents, Connections, Workflows (if enabled), Store
    // - Manage group: Monitor, Settings
    // - Plugin items / groups
    const settingsItem: NavigationSidebarItem = {
      key: "settings",
      label: "Settings",
      icon: <Settings01 />,
      isActive: isActiveRoute("settings"),
      onClick: () =>
        navigate({
          to: "/$org",
          params: { org },
          search: { settings: "org.general" },
        }),
    };

    const sections: SidebarSection[] = [
      {
        type: "items",
        items: [homeItem, tasksItem, projectsItem],
      },
      {
        type: "group",
        group: {
          id: "build",
          label: "Build",
          items: [
            ...(preferences.experimentalAutomations ? [automationsItem] : []),
            agentsItem,
            connectionsItem,
          ],
          defaultExpanded: true,
        },
      },
      {
        type: "group",
        group: {
          id: "manage",
          label: "Manage",
          items: [monitorItem, settingsItem],
          defaultExpanded: true,
        },
      },
    ];

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

  // Project-specific items (for regular projects, not org-admin)
  const projectTasksItem: NavigationSidebarItem = {
    key: "tasks",
    label: "Tasks",
    icon: <CheckDone01 />,
    isActive: isActiveRoute("tasks"),
    onClick: () =>
      navigate({
        to: "/$org/tasks",
        params: { org },
      }),
  };

  const projectWorkflowsItem: NavigationSidebarItem | null =
    enabledPlugins.includes("MCP Workflows")
      ? {
          key: "Workflows",
          label: "Workflows",
          icon: <Dataflow03 />,
          isActive: isActiveRoute("workflows"),
          onClick: () =>
            navigate({
              to: "/$org/projects/$virtualMcpId/workflows",
              params: { org, virtualMcpId },
            }),
        }
      : null;

  const configureItem: NavigationSidebarItem = {
    key: "configure",
    label: "Settings",
    icon: <Settings01 />,
    isActive: isActiveRoute("settings"),
    onClick: () =>
      navigate({
        to: "/$org/projects/$virtualMcpId/settings/general",
        params: { org, virtualMcpId },
      }),
  };

  // Regular project sidebar layout (matching Figma):
  // - Home, Tasks, Workflows, Configure
  // - [Divider] (if enabled plugins exist)
  // - Plugin items (flat)
  // - Plugin groups
  const projectItems: NavigationSidebarItem[] = [
    homeItem,
    projectTasksItem,
    ...(projectWorkflowsItem ? [projectWorkflowsItem] : []),
    configureItem,
  ];

  const sections: SidebarSection[] = [{ type: "items", items: projectItems }];

  // Add flat plugin items if any
  if (pluginItems.length > 0) {
    sections.push({ type: "divider" });
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

import { Locator, ORG_ADMIN_PROJECT_SLUG } from "@decocms/mesh-sdk";
import { useProjectContext } from "@decocms/mesh-sdk";
import type {
  NavigationSidebarItem,
  SidebarSection,
} from "@/web/components/sidebar/types";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BarChart10,
  Building02,
  CheckDone01,
  Container,
  Dataflow03,
  FaceSmile,
  Folder,
  Home02,
  LayoutLeft,
  Settings01,
  Users03,
} from "@untitledui/icons";
import { pluginRootSidebarItems, pluginSidebarGroups } from "../index.tsx";
import { useProject } from "./use-project";

export function useProjectSidebarItems(): SidebarSection[] {
  const [preferences] = usePreferences();
  const { locator, org: orgContext } = useProjectContext();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const { org, project } = Locator.parse(locator);
  const isOrgAdminProject = Locator.isOrgAdminProject(locator);

  // Fetch project data to get enabledPlugins and pinnedViews
  const { data: projectData } = useProject(orgContext.id, project);

  // All projects (including org-admin) use project-level enabledPlugins
  const enabledPlugins = projectData?.enabledPlugins ?? [];

  // Pinned views from project UI settings
  const pinnedViews =
    (
      projectData?.ui as
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
  const basePath = `/${org}/${project}`;

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
          to: "/$org/$project",
          params: { org, project },
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
        to: "/$org/$project/tasks",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      }),
  };

  const connectionsItem: NavigationSidebarItem = {
    key: "mcps",
    label: "Connections",
    icon: <Container />,
    isActive: isActiveRoute("mcps"),
    onClick: () =>
      navigate({
        to: "/$org/$project/mcps",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      }),
  };

  const projectsItem: NavigationSidebarItem = {
    key: "projects",
    label: "Projects",
    icon: <Folder />,
    isActive: isActiveRoute("projects"),
    onClick: () =>
      navigate({
        to: "/$org/$project/projects",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      }),
  };

  const storeItem: NavigationSidebarItem = {
    key: "store",
    label: "Store",
    icon: <Building02 />,
    isActive: isActiveRoute("store"),
    onClick: () =>
      navigate({
        to: "/$org/$project/store",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      }),
  };

  const agentsItem: NavigationSidebarItem = {
    key: "agents",
    label: "Agents",
    icon: <Users03 />,
    isActive: isActiveRoute("agents"),
    onClick: () =>
      navigate({
        to: "/$org/$project/agents",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      }),
  };

  const monitorItem: NavigationSidebarItem = {
    key: "monitoring",
    label: "Monitor",
    icon: <BarChart10 />,
    isActive: isActiveRoute("monitoring"),
    onClick: () =>
      navigate({
        to: "/$org/$project/monitoring",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      }),
  };

  const membersItem: NavigationSidebarItem = {
    key: "members",
    label: "Members",
    icon: <FaceSmile />,
    isActive: isActiveRoute("members"),
    onClick: () =>
      navigate({
        to: "/$org/$project/members",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG },
      }),
  };

  // Plugin items mapped to navigation items (flat items)
  const pluginItems: NavigationSidebarItem[] = enabledPluginItems.map(
    (item) => ({
      key: item.pluginId,
      label: item.label,
      icon: item.icon,
      isActive: isActiveRoute(item.pluginId),
      onClick: () =>
        navigate({
          to: "/$org/$project/$pluginId",
          params: {
            org,
            project,
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
              to: "/$org/$project/$pluginId",
              params: {
                org,
                project,
                pluginId: group.pluginId,
              },
            }),
        })),
        defaultExpanded: group.defaultExpanded ?? true,
      },
    }),
  );

  // Build pinned views sidebar items
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
        to: "/$org/$project/apps/$connectionId/$toolName",
        params: {
          org,
          project,
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
    // - Build group: Agents, Connections, Store
    // - Manage group: Monitor, Members, Settings
    // - Plugin items / groups
    const settingsItem: NavigationSidebarItem = {
      key: "settings",
      label: "Settings",
      icon: <Settings01 />,
      isActive: isActiveRoute("settings"),
      onClick: () =>
        navigate({
          to: "/$org/$project/settings",
          params: { org, project: ORG_ADMIN_PROJECT_SLUG },
        }),
    };

    const sections: SidebarSection[] = [
      {
        type: "items",
        items: [
          homeItem,
          ...(preferences.experimental_tasks ? [tasksItem] : []),
          ...(preferences.experimental_projects ? [projectsItem] : []),
        ],
      },
      {
        type: "group",
        group: {
          id: "build",
          label: "Build",
          items: [agentsItem, connectionsItem, storeItem],
          defaultExpanded: true,
        },
      },
      {
        type: "group",
        group: {
          id: "manage",
          label: "Manage",
          items: [monitorItem, membersItem, settingsItem],
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
        to: "/$org/$project/tasks",
        params: { org, project },
      }),
  };

  const projectWorkflowsItem: NavigationSidebarItem = {
    key: "workflows",
    label: "Workflows",
    icon: <Dataflow03 />,
    isActive: isActiveRoute("workflows"),
    onClick: () =>
      navigate({
        to: "/$org/$project/workflows",
        params: { org, project },
      }),
  };

  const configureItem: NavigationSidebarItem = {
    key: "configure",
    label: "Configure",
    icon: <Settings01 />,
    isActive: false,
    isExternal: true,
    onClick: () =>
      navigate({
        to: "/$org/$project/projects/$slug/settings/general",
        params: { org, project: ORG_ADMIN_PROJECT_SLUG, slug: project },
      }),
  };

  // Regular project sidebar layout (matching Figma):
  // - Home, Tasks, Workflows, Configure
  // - [Divider] (if enabled plugins exist)
  // - Plugin items (flat)
  // - Plugin groups
  const projectItems: NavigationSidebarItem[] = [
    homeItem,
    ...(preferences.experimental_tasks ? [projectTasksItem] : []),
    projectWorkflowsItem,
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

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
  FaceSmile,
  File06,
  Folder,
  Globe02,
  Home02,
  SearchMd,
  Settings01,
  TrendUp01,
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

  // Fetch project data to get enabledPlugins (sidebar is outside ProjectLayout context)
  const { data: projectData } = useProject(orgContext.id, project);

  // All projects (including org-admin) use project-level enabledPlugins
  const enabledPlugins = projectData?.enabledPlugins ?? [];

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

    return sections;
  }

  // ── Project sidebar (storefront / non-org-admin) ────────────────────────────

  const blogHired =
    typeof localStorage !== "undefined" &&
    localStorage.getItem("mesh_blog_hired") === "true";

  // Top-level items (no group)
  const projectTasksItem: NavigationSidebarItem = {
    key: "tasks",
    label: "Tasks",
    icon: <CheckDone01 />,
    isActive: isActiveRoute("tasks"),
    onClick: () =>
      navigate({ to: "/$org/$project/tasks", params: { org, project } }),
  };

  const projectAgentsItem: NavigationSidebarItem = {
    key: "hire",
    label: "Agents",
    icon: <Users03 />,
    isActive: isActiveRoute("hire"),
    onClick: () =>
      navigate({ to: "/$org/$project/hire", params: { org, project } }),
  };

  const projectConnectionsItem: NavigationSidebarItem = {
    key: "connections",
    label: "Connections",
    icon: <Container />,
    isActive: isActiveRoute("connections"),
    onClick: () =>
      navigate({ to: "/$org/$project/connections", params: { org, project } }),
  };

  // [Context] group — links to diagnostic sections
  const mkDiagnosticItem = (
    key: string,
    label: string,
    icon: React.ReactNode,
  ): NavigationSidebarItem => ({
    key,
    label,
    icon,
    isActive: isActiveRoute("diagnostic"),
    onClick: () =>
      navigate({ to: "/$org/$project/diagnostic", params: { org, project } }),
  });

  const contextItems: NavigationSidebarItem[] = [
    mkDiagnosticItem("performance", "Performance", <BarChart10 />),
    mkDiagnosticItem("seo", "SEO", <SearchMd />),
    mkDiagnosticItem("reputation", "Reputation", <Globe02 />),
    mkDiagnosticItem("benchmark", "Benchmark", <TrendUp01 />),
    mkDiagnosticItem("brand", "Brand", <FaceSmile />),
  ];

  // [Content] group — only show hired plugins
  const contentItems: NavigationSidebarItem[] = blogHired
    ? [
        {
          key: "blog",
          label: "Blog",
          icon: <File06 />,
          isActive: isActiveRoute("blog"),
          onClick: () =>
            navigate({ to: "/$org/$project/blog", params: { org, project } }),
        },
      ]
    : [];

  const sections: SidebarSection[] = [
    // Top-level — no group label
    {
      type: "items",
      items: [
        homeItem,
        projectTasksItem,
        projectAgentsItem,
        projectConnectionsItem,
      ],
    },
    // Context group
    {
      type: "group",
      group: {
        id: "context",
        label: "Context",
        items: contextItems,
        defaultExpanded: true,
      },
    },
  ];

  // Content group — only if there's something to show
  if (contentItems.length > 0) {
    sections.push({
      type: "group",
      group: {
        id: "content",
        label: "Content",
        items: contentItems,
        defaultExpanded: true,
      },
    });
  }

  return sections;
}

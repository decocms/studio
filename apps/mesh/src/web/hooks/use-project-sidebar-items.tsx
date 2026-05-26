import { useProjectContext } from "@decocms/mesh-sdk";
import type {
  NavigationSidebarItem,
  SidebarSection,
} from "@/web/components/sidebar/types";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Home01 } from "@untitledui/icons";
import { usePanelActions } from "@/web/layouts/shell-layout";

export function useProjectSidebarItems(): SidebarSection[] {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const { setTasksOpen } = usePanelActions();
  const pathname = routerState.location.pathname;
  const slug = org.slug;

  const homeItem: NavigationSidebarItem = {
    key: "home",
    label: "Home",
    icon: <Home01 className="size-4!" />,
    isActive: pathname === `/${slug}` || pathname === `/${slug}/`,
    onClick: () => {
      setTasksOpen(false);
      navigate({ to: "/$org", params: { org: slug } });
    },
  };

  return [{ type: "items", items: [homeItem] }];
}

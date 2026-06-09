import { useProjectContext } from "@decocms/mesh-sdk";
import type {
  NavigationSidebarItem,
  SidebarSection,
} from "@/web/components/sidebar/types";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Home01, Inbox01, Target04 } from "@untitledui/icons";

export function useProjectSidebarItems(): SidebarSection[] {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const slug = org.slug;

  const homeItem: NavigationSidebarItem = {
    key: "home",
    label: "Home",
    icon: <Home01 className="size-4!" />,
    isActive: pathname === `/${slug}` || pathname === `/${slug}/`,
    onClick: () => {
      navigate({ to: "/$org", params: { org: slug } });
    },
  };

  const goalsItem: NavigationSidebarItem = {
    key: "goals",
    label: "Goals",
    icon: <Target04 className="size-4!" />,
    isActive: pathname.startsWith(`/${slug}/goal`),
    onClick: () => {
      navigate({ to: "/$org/goal", params: { org: slug }, search: {} });
    },
  };

  const inboxItem: NavigationSidebarItem = {
    key: "inbox",
    label: "Inbox",
    icon: <Inbox01 className="size-4!" />,
    isActive: pathname === `/${slug}/inbox`,
    onClick: () => {
      navigate({ to: "/$org/inbox", params: { org: slug } });
    },
  };

  return [{ type: "items", items: [homeItem, goalsItem, inboxItem] }];
}

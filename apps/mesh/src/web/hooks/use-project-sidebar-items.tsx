import { useProjectContext } from "@decocms/mesh-sdk";
import type {
  NavigationSidebarItem,
  SidebarSection,
} from "@/web/components/sidebar/types";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Home01 } from "@untitledui/icons";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { BrowseAgentsButton } from "@/web/components/sidebar/browse-agents-button";

export function useProjectSidebarItems(): SidebarSection[] {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const slug = org.slug;
  const { state, isMobile } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";

  const homeItem: NavigationSidebarItem = {
    key: "home",
    label: "Home",
    icon: <Home01 className="size-4!" />,
    isActive: pathname === `/${slug}` || pathname === `/${slug}/`,
    onClick: () => {
      navigate({ to: "/$org", params: { org: slug } });
    },
  };

  const sections: SidebarSection[] = [{ type: "items", items: [homeItem] }];

  if (isCollapsed) {
    sections.push({
      type: "custom",
      key: "new-task",
      content: (
        <SidebarGroup className="pt-0 pr-0 pb-0 pl-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              <BrowseAgentsButton />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ),
    });
  }

  return sections;
}

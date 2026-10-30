/**
 * A shortcut to "Your own accounts" in Billing & AI, where the member links
 * their own Claude plan.
 * It disappears once the plan is linked.
 */

import { Link } from "@tanstack/react-router";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useT } from "@/i18n/use-t";
import { useProjectContext } from "@/sdk";
import { PROVIDER_LOGOS } from "@/utils/ai-providers-logos";
import { OWN_ACCOUNTS_ANCHOR } from "@/views/settings/ai-providers/own-accounts-section";
import { useClaudeSubscription } from "@/views/settings/ai-providers/use-claude-subscription";
import { SidebarFooterIcon } from "./icon-slot";

export function SidebarLinkClaude() {
  const t = useT();
  const { org } = useProjectContext();
  const { setOpenMobile } = useSidebar();
  const collapsed = useSidebarCollapsed();
  const { status, connected, expired } = useClaudeSubscription();

  if (!status.isSuccess || connected) return null;

  const label = expired
    ? t("sidebar.linkClaude.relink")
    : t("sidebar.linkClaude.button");

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={collapsed ? label : undefined}>
        <Link
          to="/$org/settings/ai-providers"
          params={{ org: org.slug }}
          hash={OWN_ACCOUNTS_ANCHOR}
          onClick={() => setOpenMobile(false)}
        >
          <SidebarFooterIcon>
            <img
              src={PROVIDER_LOGOS["claude-code"]}
              alt=""
              className="size-4 object-contain"
            />
          </SidebarFooterIcon>
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Shell breadcrumb — primary org navigation in the toolbar: `deco › org › agent`.
 *
 * - **deco** — the product logo, links to `/` (the cross-org "MY deco" home).
 * - **org**  — the active organization; clicking opens the org switcher popover.
 * - **agent**— the current agent, shown only inside an agent/thread route.
 *
 * This replaces the sidebar-footer popover as the place you switch orgs (the
 * footer popover now carries account/settings only). Renders inside
 * `Toolbar.LeftColumn` — see `org-shell-layout`.
 */
import { Suspense } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { ChevronDown } from "@untitledui/icons";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { useProjectContext, useVirtualMCP } from "@decocms/mesh-sdk";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  OrgIcon,
  OrgSwitcherPopover,
} from "@/web/components/header/org-switcher";

const crumbBtnClass =
  "wco-no-drag inline-flex items-center gap-1.5 min-w-0 rounded-md px-1.5 py-1 text-sm text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * Trailing agent crumb — resolves the agent entity from `?virtualmcpid` (the
 * same source the agent shell reads). Suspends on the collection fetch, so it's
 * wrapped in its own boundary and never blocks the rest of the toolbar.
 */
function AgentCrumb() {
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const entity = useVirtualMCP(search.virtualmcpid ?? null);
  // No explicit agent selected (default decopilot) → no crumb; the breadcrumb
  // stays `deco › org` on a bare chat.
  if (!entity) return null;
  const title = entity.title ?? "Agent";
  return (
    <>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <span className="inline-flex items-center gap-1.5 min-w-0 px-1.5 py-1">
          <AgentAvatar
            icon={(entity.icon as string | null) ?? null}
            name={title}
            size="2xs"
          />
          <span className="truncate font-medium">{title}</span>
        </span>
      </BreadcrumbItem>
    </>
  );
}

export function ShellBreadcrumb() {
  const { org } = useProjectContext();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const isAgentRoute = Boolean(params.taskId);

  return (
    <Breadcrumb className="wco-no-drag">
      <BreadcrumbList className="flex-nowrap">
        {/* deco → MY deco home */}
        <BreadcrumbItem>
          <Link
            to="/"
            aria-label="MY deco — all your threads"
            title="MY deco"
            className="wco-no-drag flex items-center shrink-0 cursor-pointer rounded-md px-1 hover:bg-accent/60 transition-colors"
          >
            <Toolbar.Logo />
          </Link>
        </BreadcrumbItem>

        <BreadcrumbSeparator />

        {/* org → switcher popover */}
        <BreadcrumbItem>
          <OrgSwitcherPopover
            orgParam={org.slug}
            trigger={
              <button type="button" className={crumbBtnClass}>
                <OrgIcon org={org} size="xs" />
                <span className="truncate font-medium max-w-[10rem]">
                  {org.name}
                </span>
                <ChevronDown
                  size={14}
                  className="shrink-0 text-muted-foreground opacity-70"
                />
              </button>
            }
          />
        </BreadcrumbItem>

        {/* agent → only inside a thread */}
        {isAgentRoute && (
          <Suspense fallback={null}>
            <AgentCrumb />
          </Suspense>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

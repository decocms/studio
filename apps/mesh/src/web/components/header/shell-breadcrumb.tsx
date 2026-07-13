/**
 * Shell breadcrumb — primary org/agent navigation in the toolbar:
 * `deco › org › agent`.
 *
 * - **deco**  — the product logo, links to `/` (the cross-org "MY deco" home).
 * - **org**   — the active organization; opens the org switcher popover.
 * - **agent** — the active agent, always shown (Decopilot by default). Opens the
 *   agent picker (the drawer the sidebar used to host); selecting an agent
 *   scopes the sidebar thread list to it, Decopilot = all threads. Inside a
 *   thread it snaps to that thread's agent.
 *
 * Renders inside `Toolbar.LeftColumn` — see `org-shell-layout`.
 */
import { Suspense } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { ChevronDown } from "@untitledui/icons";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  OrgIcon,
  OrgSwitcherPopover,
} from "@/web/components/header/org-switcher";
import { AgentScopePicker } from "@/web/components/sidebar/agents-section";
import { useAgentScope } from "@/web/components/sidebar/agent-scope-context";

const crumbBtnClass =
  "wco-no-drag inline-flex items-center gap-1.5 min-w-0 rounded-md px-1.5 py-1 text-sm text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * Agent crumb contents — resolves the active agent (thread's agent when inside a
 * thread, else the sidebar scope, else Decopilot). Suspends on the vMCP fetch,
 * so it's wrapped in its own boundary and never blocks the rest of the toolbar.
 */
function AgentCrumbLabel({ agentId }: { agentId: string }) {
  const entity = useVirtualMCP(agentId);
  const title = entity?.title ?? "Decopilot";
  return (
    <>
      <AgentAvatar
        icon={(entity?.icon as string | null) ?? null}
        name={title}
        size="2xs"
      />
      <span className="truncate font-medium max-w-[10rem]">{title}</span>
      <ChevronDown
        size={14}
        className="shrink-0 text-muted-foreground opacity-70"
      />
    </>
  );
}

export function ShellBreadcrumb() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const { scopeAgentId, setScopeAgentId } = useAgentScope();

  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  // Inside a thread the crumb shows that thread's agent; on the home it shows
  // the picked scope (Decopilot when none).
  const activeAgentId = params.taskId
    ? (search.virtualmcpid ?? decopilotId)
    : (scopeAgentId ?? decopilotId);

  const handlePickAgent = (id: string | null) => {
    setScopeAgentId(id);
    // Picking an agent scopes the list to it — leave any open thread so the
    // filtered home list is what you see.
    if (params.taskId) {
      navigate({ to: "/$org", params: { org: org.slug } });
    }
  };

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

        <BreadcrumbSeparator />

        {/* agent → scope picker (Decopilot = all threads) */}
        <BreadcrumbItem>
          <AgentScopePicker
            side="bottom"
            align="start"
            selectedAgentId={activeAgentId}
            onSelectAgent={handlePickAgent}
            trigger={
              <button type="button" className={crumbBtnClass}>
                <Suspense
                  fallback={
                    <span className="h-4 w-16 rounded bg-muted animate-pulse" />
                  }
                >
                  <AgentCrumbLabel agentId={activeAgentId} />
                </Suspense>
              </button>
            }
          />
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

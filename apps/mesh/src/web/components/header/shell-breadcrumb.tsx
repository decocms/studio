/**
 * Shell breadcrumb — primary org/agent navigation in the toolbar:
 * `deco › org › agent`.
 *
 * - **deco**  — the product logo, links to `/` (the cross-org "MY deco" home).
 * - **org**   — the active organization; opens the org switcher popover.
 * - **agent** — the active agent, always shown (Decopilot by default). The
 *   avatar opens the agent's home; the label opens the agent picker. Inside a
 *   thread it snaps to that thread's agent. The sidebar always lists every
 *   thread regardless of the active agent.
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
} from "@deco/ui/components/breadcrumb.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
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
import { useThreads } from "@/web/components/chat/store/hooks";
import { usePanelActions } from "@/web/layouts/shell-layout";

const crumbBtnClass =
  "wco-no-drag inline-flex items-center gap-1.5 min-w-0 rounded-md px-1.5 py-1 text-sm text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * Agent crumb — resolves the active agent (thread's agent when inside a thread,
 * else Decopilot). The avatar navigates to the agent's home (its empty "New
 * chat", or a fresh one); the label + chevron open the agent picker. Suspends on
 * the vMCP fetch, so it's wrapped in its own boundary and never blocks the toolbar.
 */
function AgentCrumb({
  agentId,
  onOpenHome,
  onPick,
}: {
  agentId: string;
  onOpenHome: () => void;
  onPick: (id: string | null) => void;
}) {
  const entity = useVirtualMCP(agentId);
  const title = entity?.title ?? "Decopilot";
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onOpenHome}
        aria-label={`Open ${title} home`}
        className="wco-no-drag flex items-center shrink-0 rounded-md p-1 hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <AgentAvatar
          icon={(entity?.icon as string | null) ?? null}
          name={title}
          size="2xs"
        />
      </button>
      <AgentScopePicker
        side="bottom"
        align="start"
        selectedAgentId={agentId}
        onSelectAgent={onPick}
        trigger={
          <button type="button" className={crumbBtnClass}>
            <span className="truncate font-medium max-w-[10rem]">{title}</span>
            <ChevronDown
              size={14}
              className="shrink-0 text-muted-foreground opacity-70"
            />
          </button>
        }
      />
    </div>
  );
}

export function ShellBreadcrumb() {
  const { org } = useProjectContext();
  const { state } = useSidebar();
  const sidebarCollapsed = state === "collapsed";
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const { threads } = useThreads();
  const { setTaskId, createNewTask } = usePanelActions();

  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  // The active agent is whatever the URL says: the thread's agent inside a
  // thread, else Decopilot (= all) on the home. This is what makes the
  // selection survive a refresh — it lives in the URL, not React state.
  const activeAgentId = params.taskId
    ? (search.virtualmcpid ?? decopilotId)
    : decopilotId;

  const handlePickAgent = (id: string | null) => {
    // Decopilot / "all" → the org home (every thread, no agent filter).
    if (!id || id === decopilotId) {
      navigate({ to: "/$org", params: { org: org.slug } });
      return;
    }
    // Open the agent's existing empty "New chat" if it has one, else start one.
    // Either way you land in a chat with that agent and the sidebar scopes to
    // it — one new chat per agent, no pile-up. A thread that has already run
    // (failed / completed / expired / requires_action) isn't a fresh home even
    // though it keeps the "New chat" title — skip it so a fresh chat opens.
    const existing = threads.find(
      (t) =>
        !t.hidden &&
        t.virtual_mcp_id === id &&
        t.title === "New chat" &&
        (!t.status || t.status === "in_progress"),
    );
    if (existing) {
      setTaskId(existing.id, id);
    } else {
      void createNewTask(id);
    }
  };

  return (
    <Breadcrumb className="wco-no-drag">
      <BreadcrumbList className="flex-nowrap">
        {/* deco logo + org switcher — one unit, no separator between them. The
            org part collapses away (logo only) when the sidebar is closed. */}
        <BreadcrumbItem className="gap-0.5">
          <Link
            to="/$org"
            params={{ org: org.slug }}
            aria-label="Organization home"
            title="Home"
            className="wco-no-drag flex items-center shrink-0 cursor-pointer rounded-md px-1 hover:bg-accent/60 transition-colors"
          >
            <Toolbar.Logo />
          </Link>
          {!sidebarCollapsed && (
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
          )}
        </BreadcrumbItem>

        {/* agent → avatar opens the agent home, label opens the picker */}
        <BreadcrumbItem>
          <Suspense
            fallback={
              <span className="h-4 w-24 rounded bg-muted animate-pulse" />
            }
          >
            <AgentCrumb
              agentId={activeAgentId}
              onOpenHome={() => handlePickAgent(activeAgentId)}
              onPick={handlePickAgent}
            />
          </Suspense>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

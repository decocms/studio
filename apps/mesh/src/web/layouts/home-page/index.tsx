import {
  getWellKnownDecopilotVirtualMCP,
  type RunningThread,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
  virtualMcpItemQueryOptions,
} from "@decocms/mesh-sdk";
import { useQuery, useSuspenseQueries } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Check, LayoutAlt04, Plus, X } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@deco/ui/components/hover-card.tsx";
import { AgentAvatar } from "@/web/components/agent-icon";
import { extractTextFromOutput } from "@/web/components/chat/message/parts/utils.ts";
import { KEYS } from "@/web/lib/query-keys";
import { useNavigate } from "@tanstack/react-router";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { Chat } from "@/web/components/chat";
import { useChatPrefs } from "@/web/components/chat/context";
import { NoAiProviderEmptyState } from "@/web/components/chat/no-ai-provider-empty-state";
import { AddTileDrawer } from "@/web/components/home/add-tile-drawer";
import {
  HomeEditProvider,
  useHomeEdit,
} from "@/web/components/home/home-edit-context";
import { HomeGrid, useHomeGridStats } from "@/web/components/home/home-grid";
import {
  aiProviderKeysQueryOptions,
  useAiProviderKeys,
} from "@/web/hooks/collections/use-ai-providers";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useDecoCredits } from "@/web/hooks/use-deco-credits";
import { homeNextActionsQueryOptions } from "@/web/hooks/use-home-next-actions";
import {
  type RunningScope,
  useRunningSummary,
} from "@/web/hooks/use-running-summary";
import { organizationSettingsQueryOptions } from "@/web/hooks/use-organization-settings";
import {
  agentHasClonableSource,
  hasLocalCliHarness,
} from "@/web/lib/agent-capabilities";
import { authClient, useActiveOrganizations } from "@/web/lib/auth-client";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { HomeBackground } from "./background";

export function HomePage() {
  const { data: session } = authClient.useSession();
  const { org } = useProjectContext();
  const isMobile = useIsMobile();
  const link = useCurrentLink();
  const { selectedVirtualMcp } = useChatPrefs();
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const displayAgent = selectedVirtualMcp ?? defaultAgent;

  // Warm the tile-gating home feed in parallel with the self tool calls below.
  // Plain (non-suspense) query so a flaky feed never blanks the home — it only
  // starts the fetch early; useHomeGridStats reads the same cache entry.
  useQuery(homeNextActionsQueryOptions(org.slug));

  // Resolve the self MCP client once, then fire every independent self tool call
  // in a single parallel batch. Without this, the stacked useSuspenseQuery hooks
  // below each suspend before the next starts, serializing into a waterfall that
  // delayed home-next-actions (and thus the tiles) by seconds.
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  useSuspenseQueries({
    queries: [
      aiProviderKeysQueryOptions(selfClient, org.id),
      organizationSettingsQueryOptions(selfClient, org.id),
      virtualMcpItemQueryOptions(org.id, displayAgent.id, selfClient),
    ],
  });

  const allKeys = useAiProviderKeys();
  const fullVm = useVirtualMCP(displayAgent.id);
  const {
    hasDecoKey,
    isZeroBalance,
    isInitialFreeCredit,
    balanceDollars,
    hasOnlyDecoProvider,
  } = useDecoCredits();
  const { hasVisibleTiles } = useHomeGridStats(org.slug);

  const isClonableAgent = agentHasClonableSource(fullVm?.metadata);
  const showProviderEmptyState =
    allKeys.length === 0 && !(isClonableAgent && hasLocalCliHarness(link));

  if (showProviderEmptyState) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full flex items-center justify-center px-4 py-10">
          <NoAiProviderEmptyState />
        </div>
      </div>
    );
  }

  const userName = session?.user?.name?.split(" ")[0] || "there";
  const showEyebrow =
    hasDecoKey && isInitialFreeCredit && balanceDollars != null;
  const showNoCreditsEyebrow =
    hasDecoKey && isZeroBalance && hasOnlyDecoProvider;
  const eyebrow = showEyebrow ? (
    <Chat.CreditsEyebrow balanceDollars={balanceDollars} />
  ) : showNoCreditsEyebrow ? (
    <Chat.NoCreditsEyebrow />
  ) : null;

  return (
    <HomeEditProvider>
      {isMobile ? (
        <MobileHome eyebrow={eyebrow} userName={userName} />
      ) : (
        <DesktopHome
          eyebrow={eyebrow}
          userName={userName}
          hasVisibleTiles={hasVisibleTiles}
        />
      )}
    </HomeEditProvider>
  );
}

function MobileHome({
  eyebrow,
  userName,
}: {
  eyebrow: ReactNode;
  userName: string;
}) {
  return (
    <div className="flex-1 relative flex flex-col items-center overflow-y-auto">
      <HomeBackground />
      <div className="relative flex flex-col items-center justify-center w-full pt-28 pb-8 px-4">
        {eyebrow && <div className="mb-4">{eyebrow}</div>}
        <p className="text-3xl font-medium text-foreground text-center max-w-[280px]">
          What's on your mind, {userName}?
        </p>
        <RunningSummaryLine />
      </div>
      <div className="relative w-full flex flex-col gap-4 pb-8 px-4">
        <Chat.Input showConnectionsBanner />
      </div>
      <div className="relative w-full px-4 pb-8">
        <HomeGrid isEditMode={false} />
      </div>
    </div>
  );
}

function DesktopHome({
  eyebrow,
  userName,
  hasVisibleTiles,
}: {
  eyebrow: ReactNode;
  userName: string;
  hasVisibleTiles: boolean;
}) {
  const { isEditMode, enter, save, cancel, hasChanges } = useHomeEdit();
  const [addTileOpen, setAddTileOpen] = useState(false);

  return (
    <>
      <Toolbar.Right>
        <CustomizeToolbar
          isEditMode={isEditMode}
          hasChanges={hasChanges}
          onEnter={enter}
          onSave={save}
          onCancel={cancel}
          onAddTile={() => setAddTileOpen(true)}
        />
      </Toolbar.Right>
      <AddTileDrawer open={addTileOpen} onOpenChange={setAddTileOpen} />
      <div className="flex-1 relative flex flex-col min-h-0">
        <HomeBackground />
        <div className="flex-1 relative flex flex-col overflow-y-auto">
          <div
            className={cn(
              "relative flex flex-col items-center px-10 pb-4",
              hasVisibleTiles || isEditMode ? "pt-32" : "flex-1 justify-center",
            )}
          >
            <div className="flex flex-col items-center w-full max-w-[672px]">
              <div className="text-center mb-10">
                {eyebrow && <div className="mb-4">{eyebrow}</div>}
                <p className="text-3xl font-medium text-foreground">
                  What's on your mind, {userName}?
                </p>
                <RunningSummaryLine />
              </div>
              <div className="relative w-full">
                <Capybara />
                <Chat.Input showConnectionsBanner />
              </div>
            </div>
            <div className="relative w-full mt-10 mx-auto max-w-[1280px] px-2 pb-16">
              <HomeGrid isEditMode={isEditMode} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function CustomizeToolbar({
  isEditMode,
  hasChanges,
  onEnter,
  onSave,
  onCancel,
  onAddTile,
}: {
  isEditMode: boolean;
  hasChanges: boolean;
  onEnter: () => void;
  onSave: () => void;
  onCancel: () => void;
  onAddTile: () => void;
}) {
  if (isEditMode) {
    return (
      <>
        <button
          type="button"
          onClick={onAddTile}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          title="Add a tile from any agent"
        >
          <Plus size={14} />
          Add tile
        </button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          className="gap-1.5 h-7 text-xs"
        >
          <X size={14} />
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={!hasChanges}
          className="gap-1.5 h-7 text-xs"
        >
          <Check size={14} />
          Save
        </Button>
      </>
    );
  }
  return (
    <button
      type="button"
      onClick={onEnter}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
      title="Customize your home"
    >
      <LayoutAlt04 size={14} />
      Customize
    </button>
  );
}

/**
 * "X agents working on N tasks" — live count of in_progress threads in the org,
 * seeded by the /watch connect snapshot and kept fresh by the reactor's
 * running-summary broadcasts. Renders nothing when nothing is running. Hovering
 * reveals the running threads, each with its agent and latest assistant snippet;
 * clicking a row opens that thread.
 */
const SCOPE_STORAGE_KEY = "running-summary-scope";

function readScope(): RunningScope {
  // Default to "user" (All my work); only "org" when explicitly chosen.
  try {
    return localStorage.getItem(SCOPE_STORAGE_KEY) === "org" ? "org" : "user";
  } catch {
    return "user";
  }
}

function RunningSummaryLine() {
  const { org } = useProjectContext();
  const [scope, setScopeState] = useState<RunningScope>(readScope);
  const setScope = (next: RunningScope) => {
    setScopeState(next);
    try {
      localStorage.setItem(SCOPE_STORAGE_KEY, next);
    } catch {
      // ignore (private mode / disabled storage)
    }
  };

  // Subscribe to both feeds so the badge is visible (and the scope toggle
  // reachable) whenever EITHER scope has work — switching never unmounts it.
  const orgState = useRunningSummary(org.slug, "org");
  const userState = useRunningSummary(org.slug, "user");

  if (
    orgState.summary.totalRunning === 0 &&
    userState.summary.totalRunning === 0
  ) {
    return null;
  }

  const state = scope === "user" ? userState : orgState;
  const { totalRunning, agentCount } = state.summary;
  const emptyLabel =
    scope === "user"
      ? "Nothing running across your orgs"
      : "Nothing running in this org";
  const label =
    totalRunning === 0
      ? emptyLabel
      : agentCount > 0
        ? `${agentCount} agent${agentCount === 1 ? "" : "s"} working on ${totalRunning} task${totalRunning === 1 ? "" : "s"}`
        : `${totalRunning} task${totalRunning === 1 ? "" : "s"} running`;

  return (
    <HoverCard openDelay={120} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="mt-3 flex items-center justify-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {totalRunning > 0 ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : null}
          {label}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="center" className="w-80 p-1">
        <div className="flex items-center gap-1 px-1 pb-1">
          <ScopeTab
            active={scope === "org"}
            count={orgState.summary.totalRunning}
            onClick={() => setScope("org")}
          >
            This org
          </ScopeTab>
          <ScopeTab
            active={scope === "user"}
            count={userState.summary.totalRunning}
            onClick={() => setScope("user")}
          >
            All my work
          </ScopeTab>
        </div>
        <RunningThreadsList threads={state.threads} scope={scope} />
      </HoverCardContent>
    </HoverCard>
  );
}

function ScopeTab({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      {count > 0 ? ` (${count})` : ""}
    </button>
  );
}

function RunningThreadsList({
  threads,
  scope,
}: {
  threads: RunningThread[];
  scope: RunningScope;
}) {
  const { data: orgs } = useActiveOrganizations();
  const slugByOrgId = new Map<string, string>(
    (orgs ?? []).map(
      (o: { id: string; slug: string }): [string, string] => [o.id, o.slug],
    ),
  );

  if (threads.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-xs text-muted-foreground">
        {scope === "user"
          ? "Nothing running across your orgs."
          : "Nothing running in this org."}
      </div>
    );
  }

  return (
    <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
      {threads.map((thread) => (
        <RunningThreadRow
          key={`${thread.organization_id}:${thread.id}`}
          thread={thread}
          orgSlug={slugByOrgId.get(thread.organization_id)}
        />
      ))}
    </div>
  );
}

function RunningThreadRow({
  thread,
  orgSlug,
}: {
  thread: RunningThread;
  orgSlug: string | undefined;
}) {
  const navigate = useNavigate();
  const agent = useVirtualMCP(thread.virtual_mcp_id);
  // Resolve agent from the current org's cache; for cross-org rows that misses,
  // so fall back to the server-supplied agent_title.
  const agentName = agent?.title ?? thread.agent_title ?? "Agent";

  // Latest message, fetched lazily when the popover mounts, against the THREAD's
  // own org (cross-org threads need their own client). A running thread's newest
  // message is normally the streaming assistant turn.
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: thread.organization_id,
    orgSlug: orgSlug ?? "",
  });
  const { data: snippet } = useQuery({
    queryKey: KEYS.runningThreadLatest(thread.organization_id, thread.id),
    enabled: !!orgSlug && !!client,
    queryFn: async () => {
      if (!client) return null;
      const result = (await client.callTool({
        name: "COLLECTION_THREAD_MESSAGES_LIST",
        arguments: {
          thread_id: thread.id,
          limit: 1,
          orderBy: [{ field: "created_at", direction: "desc" }],
        },
      })) as { structuredContent?: { items?: unknown[] }; items?: unknown[] };
      const items = result.structuredContent?.items ?? result.items ?? [];
      const latest = items[0] as { role?: string } | undefined;
      if (!latest || latest.role !== "assistant") return null;
      return extractTextFromOutput(latest);
    },
    staleTime: 5_000,
  });

  const open = () => {
    if (!orgSlug) return;
    navigate({
      to: "/$org/$taskId",
      params: { org: orgSlug, taskId: thread.id },
      search: { chat: 1, virtualmcpid: thread.virtual_mcp_id || undefined },
    });
  };

  return (
    <button
      type="button"
      onClick={open}
      disabled={!orgSlug}
      className="flex w-full items-start gap-2 rounded-md p-2 text-left transition-colors hover:bg-muted disabled:opacity-60"
    >
      <AgentAvatar icon={agent?.icon ?? null} name={agentName} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {thread.title || "Untitled task"}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {agentName}
        </div>
        {snippet ? (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {snippet}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function Capybara() {
  return (
    <img
      src="/home/capybara.png"
      alt=""
      aria-hidden
      className="pointer-events-none absolute -top-16 right-6 z-20 h-20 w-auto select-none"
    />
  );
}

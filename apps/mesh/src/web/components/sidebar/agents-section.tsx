import { Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { CollectionSearch } from "@deco/ui/components/collection-search.tsx";
import { Globe02, Plus } from "@untitledui/icons";
import {
  isDecopilot,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { usePinnedAgents } from "@/web/hooks/use-pinned-agents";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import {
  HYDROGEN_TEMPLATE,
  SHOPIFY_HYDROGEN_ICON,
  WEBSITE_TEMPLATE,
  useCreateAgentFromTemplate,
} from "@/web/hooks/use-create-website-agent";
import { track } from "@/web/lib/posthog-client";
import { AgentAvatar } from "@/web/components/agent-icon";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker.tsx";
import { useThreadActions } from "@/web/components/chat/store/hooks";
import { readCachedTaskBranch } from "@/web/lib/read-cached-task-branch";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { usePublicConfig } from "@/web/hooks/use-public-config";

function useIsDecoUser() {
  const { enableDecoImport } = usePublicConfig();
  const { data: session } = authClient.useSession();
  const { data } = useQuery({
    queryKey: KEYS.decoProfile(session?.user?.email),
    queryFn: async () => {
      const res = await fetch("/api/deco-sites/profile");
      if (!res.ok) return { isDecoUser: false };
      return res.json() as Promise<{ isDecoUser: boolean }>;
    },
    enabled: Boolean(enableDecoImport) && Boolean(session?.user?.email),
    staleTime: 5 * 60_000,
  });
  return data?.isDecoUser ?? false;
}

/**
 * Hook for "spawn task on this vMCP" buttons (used by the browse-agents
 * popover). When the user clicks a vMCP that matches the URL's current
 * virtualmcpid, the active task's branch is carried into the new thread
 * so the new task lands on the same warm sandbox. When the clicked vMCP
 * differs, no branch is passed and the server picks the most-recently-
 * touched sandboxMap entry for that vMCP.
 */
function useNavigateToNewTaskWithBranchCarry(orgSlug: string) {
  const navigate = useNavigate();
  const { create } = useThreadActions();
  const { locator } = useProjectContext();
  const params = useParams({ strict: false }) as { taskId?: string };
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };

  return async (clickedVirtualMcpId: string) => {
    const taskId = crypto.randomUUID();
    const carryBranch =
      clickedVirtualMcpId === search.virtualmcpid
        ? readCachedTaskBranch(orgSlug, locator, params.taskId ?? "")
        : null;
    try {
      await create({
        id: taskId,
        virtual_mcp_id: clickedVirtualMcpId,
        ...(carryBranch ? { branch: carryBranch } : {}),
      });
    } catch {
      // Toast already fired; navigate anyway so the route loader's
      // ensure-fallback can retry.
    }
    navigate({
      to: "/$org/$taskId",
      params: { org: orgSlug, taskId },
      search: { virtualmcpid: clickedVirtualMcpId },
    });
  };
}

function AgentGridItem({
  agent,
  onClick,
}: {
  agent: VirtualMCPEntity;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group"
    >
      <AgentAvatar
        icon={agent.icon}
        name={agent.title}
        size="md"
        className="transition-transform group-hover:scale-105"
      />
      <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground line-clamp-2 w-full">
        {agent.title}
      </span>
    </button>
  );
}

function PinAgentPopoverContent({
  onClose,
  onOpenImportDeco,
  onOpenGithubImport,
}: {
  onClose: () => void;
  onOpenImportDeco: () => void;
  onOpenGithubImport: () => void;
}) {
  const [search, setSearch] = useState("");
  const allAgents = useVirtualMCPs();
  const { org } = useProjectContext();
  const serverPinnedIds = allAgents.filter((a) => a.pinned).map((a) => a.id);
  const { pin, isPinned } = usePinnedAgents(org.id, serverPinnedIds);
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const { createFromTemplate, isCreating: isCreatingFromTemplate } =
    useCreateAgentFromTemplate();
  const [preferences] = usePreferences();
  const isDecoUser = useIsDecoUser();

  const navigateToNewTask = useNavigateToNewTaskWithBranchCarry(org.slug);

  const lowerSearch = search.toLowerCase();
  const userAgents = allAgents
    .filter((s) => !isDecopilot(s.id))
    .filter((s) => !search || s.title.toLowerCase().includes(lowerSearch));

  const handleSelect = (agent: VirtualMCPEntity) => {
    if (!isPinned(agent.id)) {
      pin(agent.id);
    }
    onClose();
    setSearch("");
    navigateToNewTask(agent.id);
  };

  return (
    <div className="flex flex-col max-h-[min(640px,80dvh)]">
      {/* Search */}
      <CollectionSearch
        value={search}
        onChange={setSearch}
        placeholder="Search agents..."
      />

      {/* Scrollable content */}
      <div className="overflow-y-auto flex-1 min-h-0 px-3 pb-3">
        {/* Agents section */}
        <div className="px-1 pt-3 pb-2">
          <span className="text-xs font-medium text-muted-foreground">
            Agents
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {/* Create new button */}
          <button
            type="button"
            disabled={isCreating}
            onClick={async () => {
              track("agent_create_new_clicked", { source: "browse_popover" });
              await createVirtualMCP();
              onClose();
            }}
            className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-12 h-12 rounded-xl border-2 border-dashed border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
              <Plus size={16} className="text-muted-foreground" />
            </div>
            <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
              Create new
            </span>
          </button>

          <button
            type="button"
            disabled={isCreatingFromTemplate}
            onClick={async () => {
              track("agent_create_clicked", {
                source: "browse_popover",
                method: "website",
              });
              await createFromTemplate(WEBSITE_TEMPLATE);
              onClose();
            }}
            className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-12 h-12 rounded-xl border-2 border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
              <Globe02 className="size-5 text-muted-foreground" />
            </div>
            <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
              Start Website
            </span>
          </button>

          <button
            type="button"
            disabled={isCreatingFromTemplate}
            onClick={async () => {
              track("agent_create_clicked", {
                source: "browse_popover",
                method: "hydrogen",
              });
              await createFromTemplate(HYDROGEN_TEMPLATE);
              onClose();
            }}
            className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="w-12 h-12 rounded-xl border-2 border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
              <img
                src={SHOPIFY_HYDROGEN_ICON}
                alt=""
                className="size-5 object-contain"
              />
            </div>
            <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
              Shopify Headless Store
            </span>
          </button>

          {preferences.experimental_vibecode && (
            <button
              type="button"
              onClick={() => {
                track("agent_import_clicked", { source: "github" });
                onOpenGithubImport();
                onClose();
              }}
              className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group"
            >
              <div className="w-12 h-12 rounded-xl border-2 border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
                <GitHubIcon className="size-5 text-muted-foreground" />
              </div>
              <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
                Import GitHub
              </span>
            </button>
          )}

          {isDecoUser && (
            <button
              type="button"
              onClick={() => {
                track("agent_import_clicked", { source: "deco" });
                onOpenImportDeco();
                onClose();
              }}
              className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-accent cursor-pointer group"
            >
              <div className="w-12 h-12 rounded-xl border-2 border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105">
                <img
                  src="/logos/deco%20logo.svg"
                  alt=""
                  className="size-5 object-contain"
                />
              </div>
              <span className="text-xs leading-tight text-center text-muted-foreground group-hover:text-foreground">
                Import deco.cx
              </span>
            </button>
          )}

          {userAgents.map((agent) => (
            <AgentGridItem
              key={agent.id}
              agent={agent}
              onClick={() => handleSelect(agent)}
            />
          ))}
        </div>

        {userAgents.length === 0 && !isCreating && (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
            {search ? "No agents found" : "No agents yet"}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-2.5">
        <Link
          to="/$org/settings/agents"
          params={{ org: org.slug }}
          onClick={() => onClose()}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
        >
          See all agents
        </Link>
      </div>
    </div>
  );
}

function PinAgentPopover({ compact = false }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [importDecoOpen, setImportDecoOpen] = useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = useState(false);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  const handleClose = () => {
    setOpen(false);
    if (isMobile) setOpenMobile(false);
  };

  const popoverContent = open && (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-8">
          <Skeleton className="h-4 w-24" />
        </div>
      }
    >
      <PinAgentPopoverContent
        onClose={handleClose}
        onOpenImportDeco={() => setImportDecoOpen(true)}
        onOpenGithubImport={() => {
          setGithubPickerOpen(true);
          handleClose();
        }}
      />
    </Suspense>
  );

  return (
    <>
      {isMobile ? (
        <>
          {compact ? (
            <ToolbarIconButton
              aria-label="Browse agents"
              onClick={() => {
                track("agent_browser_opened", { surface: "mobile_drawer" });
                setOpen(true);
              }}
            >
              <Plus className="size-4" />
            </ToolbarIconButton>
          ) : (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Browse agents"
                onClick={() => {
                  track("agent_browser_opened", { surface: "mobile_drawer" });
                  setOpen(true);
                }}
              >
                <Plus />
                <span>New agent</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <Drawer open={open} onOpenChange={setOpen} direction="bottom">
            <DrawerContent className="max-h-[85dvh] p-0">
              <DrawerTitle className="sr-only">Browse agents</DrawerTitle>
              {popoverContent}
            </DrawerContent>
          </Drawer>
        </>
      ) : (
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next && !open) {
              track("agent_browser_opened", { surface: "desktop_popover" });
            }
            setOpen(next);
          }}
        >
          {compact ? (
            <PopoverTrigger asChild>
              <ToolbarIconButton aria-label="Browse agents">
                <Plus className="size-4" />
              </ToolbarIconButton>
            </PopoverTrigger>
          ) : (
            <SidebarMenuItem>
              <PopoverTrigger asChild>
                <SidebarMenuButton tooltip="Browse agents">
                  <Plus />
                  <span>New agent</span>
                </SidebarMenuButton>
              </PopoverTrigger>
            </SidebarMenuItem>
          )}
          <PopoverContent
            className="w-[380px] p-0 overflow-hidden"
            side="right"
            align="start"
          >
            {popoverContent}
          </PopoverContent>
        </Popover>
      )}
      <ImportFromDecoDialog
        open={importDecoOpen}
        onOpenChange={setImportDecoOpen}
      />
      <GitHubRepoPicker
        open={githubPickerOpen}
        onOpenChange={setGithubPickerOpen}
      />
    </>
  );
}

/**
 * BrowseAgentsButton — the "+" sidebar button that opens the Browse Agents
 * popover (desktop) / drawer (mobile). Re-exported from this module so other
 * sidebar surfaces can mount the trigger without depending on the full agents
 * list. Same component as PinAgentPopover.
 */
export { PinAgentPopover as BrowseAgentsButton };

import { AgentAvatar } from "@/web/components/agent-icon";
import { useNavigate, useMatch } from "@tanstack/react-router";
import { Suspense } from "react";
import { authClient } from "@/web/lib/auth-client";
import { useProjects } from "@/web/hooks/use-projects";
import { useCreateProject } from "@/web/hooks/use-create-project";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  ChevronSelectorVertical,
  Check,
  Plus,
  Settings01,
  Building02,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { UserProjectItems, ProjectListSkeleton } from "./project-panel";
import { CreateOrganizationDialog } from "@/web/components/create-organization-dialog";
import { useState } from "react";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";

function getOrgColorStyle(name: string): {
  backgroundColor: string;
  color: string;
} {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return {
    backgroundColor: `hsl(${h} 55% 70%)`,
    color: `hsl(${h} 55% 20%)`,
  };
}

function OrgIcon({
  org,
  size = "sm",
}: {
  org: { name: string; logo?: string | null };
  size?: "xs" | "sm";
}) {
  const sizeClass = size === "xs" ? "size-5" : "size-6";
  const textClass = size === "xs" ? "text-[9px]" : "text-xs";

  return (
    <div
      className={cn(
        sizeClass,
        "shrink-0 rounded-md flex items-center justify-center border border-border/50 overflow-hidden",
      )}
      style={org.logo ? undefined : getOrgColorStyle(org.name)}
    >
      {org.logo ? (
        <img src={org.logo} alt="" className="size-full object-cover" />
      ) : (
        <span className={cn("font-semibold leading-none", textClass)}>
          {org.name.slice(0, 2).toUpperCase()}
        </span>
      )}
    </div>
  );
}

interface MeshAccountSwitcherProps {
  isCollapsed?: boolean;
}

export function MeshAccountSwitcher({
  isCollapsed = false,
}: MeshAccountSwitcherProps) {
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const projectMatch = useMatch({
    from: "/shell/$org/projects/$virtualMcpId",
    shouldThrow: false,
  });
  const orgParam = orgMatch?.params.org;
  const currentVirtualMcpId = projectMatch?.params.virtualMcpId;
  const { data: organizations } = authClient.useListOrganizations();
  const navigate = useNavigate();

  const currentOrg = organizations?.find((o) => o.slug === orgParam);

  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [showOrgList, setShowOrgList] = useState(false);
  const isMobile = useIsMobile();

  const projects = useProjects();
  const currentProject = currentVirtualMcpId
    ? projects.find((p) => p.id === currentVirtualMcpId)
    : null;
  const isStudio = !currentVirtualMcpId;

  const handleSelectStudio = () => {
    if (!orgParam) return;
    navigate({
      to: "/$org",
      params: { org: orgParam },
    });
  };

  const handleSelectProject = (projectSlug: string) => {
    // Project selection now needs the virtual MCP ID, not the slug
    // This is handled by the project-panel component which passes the ID
    if (!orgParam) return;
    navigate({
      to: "/$org/projects/$virtualMcpId",
      params: { org: orgParam, virtualMcpId: projectSlug },
    });
  };

  const handleSelectOrg = (orgSlug: string) => {
    navigate({
      to: "/$org",
      params: { org: orgSlug },
    });
  };

  const { createProject } = useCreateProject();

  const handleSettings = () => {
    if (!orgParam) return;
    navigate({
      to: "/$org",
      params: { org: orgParam },
      search: { settings: "org.general" },
    });
  };

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) setShowOrgList(false);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-3 rounded-md p-1.5 pr-2 text-left hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring min-h-[2.75rem]",
              isCollapsed ? "w-auto pr-1.5" : "w-full",
            )}
          >
            {isStudio ? (
              <div
                className={cn(
                  "shrink-0 rounded-md flex items-center justify-center border border-border/50 overflow-hidden transition-[width,height] duration-300 ease-[var(--ease-out-quart)]",
                  isCollapsed ? "size-6" : "size-8",
                )}
                style={
                  currentOrg?.logo
                    ? undefined
                    : getOrgColorStyle(currentOrg?.name ?? "")
                }
              >
                {currentOrg?.logo ? (
                  <img
                    src={currentOrg.logo}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <span
                    className={cn(
                      "font-semibold leading-none",
                      isCollapsed ? "text-[9px]" : "text-xs",
                    )}
                  >
                    {(currentOrg?.name ?? "?").slice(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
            ) : (
              <AgentAvatar
                icon={currentProject?.icon}
                name={currentProject?.title ?? "Project"}
                size={isCollapsed ? "xs" : "sm"}
                className="shrink-0"
              />
            )}
            {!isCollapsed && (
              <>
                <div className="flex-1 min-w-0 flex flex-col justify-center">
                  <span className="block text-[11px] text-sidebar-foreground/50 leading-tight truncate">
                    {currentOrg?.name ?? "Select org"}
                  </span>
                  <span className="block text-sm font-semibold text-sidebar-foreground truncate leading-tight">
                    {currentProject?.title ?? "Studio"}
                  </span>
                </div>
                <ChevronSelectorVertical
                  size={16}
                  className="shrink-0 text-sidebar-foreground/40"
                />
              </>
            )}
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          side="bottom"
          className="w-64 flex flex-col gap-0.5"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {isMobile && showOrgList ? (
            <>
              {[...(organizations ?? [])]
                .sort((a, b) => {
                  if (a.slug === orgParam) return -1;
                  if (b.slug === orgParam) return 1;
                  return a.name.localeCompare(b.name);
                })
                .map((org) => (
                  <DropdownMenuItem
                    key={org.id}
                    className={cn(
                      "gap-2.5",
                      org.slug === orgParam && "bg-accent",
                    )}
                    onClick={() => handleSelectOrg(org.slug)}
                  >
                    <OrgIcon org={org} size="xs" />
                    <span className="flex-1 truncate">{org.name}</span>
                    {org.slug === orgParam && (
                      <Check
                        size={14}
                        className="ml-auto text-muted-foreground shrink-0"
                      />
                    )}
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2.5"
                onClick={() => setCreatingOrganization(true)}
              >
                <Plus size={14} className="shrink-0 text-muted-foreground" />
                <span>Create organization</span>
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {/* Studio */}
              <DropdownMenuItem
                className={cn("gap-2.5", isStudio && "bg-accent")}
                onClick={handleSelectStudio}
              >
                {currentOrg && <OrgIcon org={currentOrg} />}
                <span className="flex-1 truncate">
                  Studio · {currentOrg?.name}
                </span>
                {isStudio && (
                  <Check
                    size={14}
                    className="ml-auto text-muted-foreground shrink-0"
                  />
                )}
              </DropdownMenuItem>

              <p className="px-2 pt-2 pb-0.5 text-[11px] font-medium text-muted-foreground/50 uppercase tracking-wider">
                Projects
              </p>

              {currentOrg && (
                <Suspense fallback={<ProjectListSkeleton />}>
                  <UserProjectItems
                    currentProjectId={currentVirtualMcpId}
                    orgSlug={orgParam ?? ""}
                    onSelect={handleSelectProject}
                  />
                </Suspense>
              )}

              <DropdownMenuItem className="gap-2.5" onClick={createProject}>
                <Plus size={14} className="shrink-0 text-muted-foreground" />
                <span>Create project</span>
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              {/* Switch organization — flyout on desktop, inline on mobile */}
              {isMobile ? (
                <DropdownMenuItem
                  className="gap-2.5"
                  onSelect={(e) => {
                    e.preventDefault();
                    setShowOrgList(true);
                  }}
                >
                  <Building02
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span>Switch organization</span>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2.5">
                    <Building02
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span>Switch organization</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-48 flex flex-col gap-0.5">
                    {[...(organizations ?? [])]
                      .sort((a, b) => {
                        if (a.slug === orgParam) return -1;
                        if (b.slug === orgParam) return 1;
                        return a.name.localeCompare(b.name);
                      })
                      .map((org) => (
                        <DropdownMenuItem
                          key={org.id}
                          className={cn(
                            "gap-2.5",
                            org.slug === orgParam && "bg-accent",
                          )}
                          onClick={() => handleSelectOrg(org.slug)}
                        >
                          <OrgIcon org={org} size="xs" />
                          <span className="flex-1 truncate">{org.name}</span>
                          {org.slug === orgParam && (
                            <Check
                              size={14}
                              className="ml-auto text-muted-foreground shrink-0"
                            />
                          )}
                        </DropdownMenuItem>
                      ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="gap-2.5"
                      onClick={() => setCreatingOrganization(true)}
                    >
                      <Plus
                        size={14}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span>Create organization</span>
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}

              <DropdownMenuItem className="gap-2.5" onClick={handleSettings}>
                <Settings01
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
                <span>Settings</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateOrganizationDialog
        open={creatingOrganization}
        onOpenChange={setCreatingOrganization}
      />
    </>
  );
}

MeshAccountSwitcher.Skeleton = function MeshAccountSwitcherSkeleton() {
  return (
    <div className="flex items-center gap-1.5 h-7 px-1.5 w-full">
      <Skeleton className="size-5 rounded-[5px] shrink-0 bg-sidebar-accent" />
      <Skeleton className="h-3.5 flex-1 bg-sidebar-accent" />
    </div>
  );
};

import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "@/web/lib/auth-client";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { ChevronSelectorVertical } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { UserPanel } from "./user-panel";
import { OrgPanel } from "./org-panel";
import { ProjectPanel } from "./project-panel";
import { CreateOrganizationDialog } from "@/web/components/create-organization-dialog";
import { UserSettingsDialog } from "@/web/components/user-settings-dialog";

interface MeshAccountSwitcherProps {
  isCollapsed?: boolean;
  /** Callback when creating a new project */
  onCreateProject?: () => void;
}

export function MeshAccountSwitcher({
  isCollapsed = false,
  onCreateProject,
}: MeshAccountSwitcherProps) {
  const [preferences] = usePreferences();
  const { org: orgParam, project: projectParam } = useParams({ strict: false });
  const { data: organizations } = authClient.useListOrganizations();
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();

  // Get project context for showing current project name
  const projectContext = useProjectContext();
  const currentProject = projectContext?.project;

  const currentOrg = organizations?.find(
    (organization) => organization.slug === orgParam,
  );

  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [hoveredOrgId, setHoveredOrgId] = useState<string | null>(null);

  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  // Get the hovered org or fall back to current org
  const hoveredOrg = hoveredOrgId
    ? organizations?.find((o) => o.id === hoveredOrgId)
    : currentOrg;

  const handleOrgSettings = (orgSlug: string) => {
    setOpen(false);
    navigate({
      to: "/$org/$project/settings",
      params: { org: orgSlug, project: ORG_ADMIN_PROJECT_SLUG },
    });
  };

  const handleSelectOrg = (orgSlug: string) => {
    setOpen(false);
    navigate({
      to: "/$org/$project",
      params: { org: orgSlug, project: ORG_ADMIN_PROJECT_SLUG },
    });
  };

  const handleSelectProject = (orgSlug: string, projectSlug: string) => {
    setOpen(false);
    navigate({
      to: "/$org/$project",
      params: { org: orgSlug, project: projectSlug },
    });
  };

  const handleProjectSettings = (orgSlug: string, projectSlug: string) => {
    setOpen(false);
    navigate({
      to: "/$org/$project/settings",
      params: { org: orgSlug, project: projectSlug },
    });
  };

  const handleCreateProject = onCreateProject
    ? () => {
        setOpen(false);
        onCreateProject();
      }
    : undefined;

  // Reset hovered org when popover closes
  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setHoveredOrgId(null);
    }
  };

  // When popover opens, default to hovering the current org
  const handlePopoverOpen = () => {
    if (currentOrg) {
      setHoveredOrgId(currentOrg.id);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePopoverOpen}
            className={cn(
              "h-7 min-w-0 max-w-full hover:bg-sidebar-accent text-sidebar-foreground",
              isCollapsed ? "justify-center" : "justify-start",
              isCollapsed ? "" : "pl-0.5! px-1.5 gap-1.5",
            )}
          >
            <Avatar
              url={currentOrg?.logo ?? ""}
              fallback={currentOrg?.name ?? ""}
              size="xs"
              className="shrink-0 rounded-[5px]"
              objectFit="cover"
            />
            {!isCollapsed && (
              <>
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-[10px] text-sidebar-foreground/50 leading-none truncate">
                    {currentOrg?.name ?? "Select org"}
                  </p>
                  <p className="text-sm font-normal leading-tight mt-0.5 truncate text-sidebar-foreground">
                    {currentProject?.name ?? currentProject?.slug ?? ""}
                  </p>
                </div>
                <ChevronSelectorVertical className="size-3 text-sidebar-foreground/50 shrink-0" />
              </>
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          side="bottom"
          className="p-0 flex w-auto h-88 overflow-hidden"
        >
          {/* User panel */}
          {user && (
            <UserPanel
              user={user}
              userImage={userImage}
              onOpenSettings={() => {
                setSettingsOpen(true);
                setOpen(false);
              }}
            />
          )}

          {/* Organization panel */}
          <OrgPanel
            currentOrgSlug={orgParam}
            hoveredOrgId={hoveredOrgId}
            onOrgSelect={handleSelectOrg}
            onOrgSettings={handleOrgSettings}
            onPopoverClose={() => setOpen(false)}
            onCreateOrganization={() => setCreatingOrganization(true)}
            onOrgHover={setHoveredOrgId}
          />

          {/* Project panel - shows projects for hovered org */}
          {preferences.experimental_projects && hoveredOrg && (
            <ProjectPanel
              organizationId={hoveredOrg.id}
              organizationName={hoveredOrg.name}
              orgSlug={hoveredOrg.slug}
              currentProjectSlug={
                hoveredOrg.slug === orgParam ? projectParam : undefined
              }
              onProjectSelect={handleSelectProject}
              onProjectSettings={handleProjectSettings}
              onCreateProject={handleCreateProject}
            />
          )}
        </PopoverContent>
      </Popover>

      {user && settingsOpen && user.email && (
        <UserSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          user={{ ...user, name: user.name ?? undefined, email: user.email }}
          userImage={userImage}
        />
      )}

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

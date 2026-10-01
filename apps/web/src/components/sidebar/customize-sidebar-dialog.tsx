/**
 * Customize sidebar: every project, grouped by the org's folders. Each row
 * says, in words, where the project is in the member's sidebar; each folder
 * has one switch for showing it. Org-wide edits (move, rename, delete) sit
 * behind "⋯" so they never read as the member's own settings.
 */

import type { ReactNode } from "react";
import { DotsHorizontal, Folder, Plus } from "@untitledui/icons";
import type {
  ProjectFolder,
  SidebarPreferences,
} from "@decocms/shared/project-sidebar";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ProjectIcon } from "@/components/project-icon";
import { useT } from "@/i18n/use-t.ts";
import type { FolderNameRequest } from "./folder-name-dialog";

type RowState = "pinned" | "shown" | "hidden";

export function CustomizeSidebarDialog({
  open,
  onOpenChange,
  projects,
  folders,
  preferences,
  canManage,
  onPin,
  onHide,
  onHideFolder,
  onMove,
  onRequestFolderName,
  onDeleteFolder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly VirtualMCPEntity[];
  folders: readonly ProjectFolder[];
  preferences: SidebarPreferences;
  canManage: boolean;
  onPin: (projectId: string, on: boolean) => void;
  onHide: (projectId: string, on: boolean) => void;
  onHideFolder: (folderId: string, on: boolean) => void;
  onMove: (projectId: string, folderId: string | null) => void;
  onRequestFolderName: (request: FolderNameRequest) => void;
  onDeleteFolder: (folderId: string) => void;
}) {
  const t = useT();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const placed = new Set(folders.flatMap((f) => f.projectIds));
  const pinned = new Set(preferences.pinned);
  const hidden = new Set(preferences.hidden);
  const hiddenFolders = new Set(preferences.hiddenFolders);

  const setState = (projectId: string, state: RowState) => {
    if (state === "pinned") onPin(projectId, true);
    else if (state === "hidden") onHide(projectId, true);
    // "Shown" clears whichever decision the project had.
    else if (pinned.has(projectId)) onPin(projectId, false);
    else onHide(projectId, false);
  };

  const row = (project: VirtualMCPEntity, folder: ProjectFolder | null) => {
    const folderHidden = folder !== null && hiddenFolders.has(folder.id);
    const state: RowState = pinned.has(project.id)
      ? "pinned"
      : hidden.has(project.id)
        ? "hidden"
        : "shown";
    const offInSidebar =
      state === "hidden" || (folderHidden && state !== "pinned");

    return (
      <li
        key={project.id}
        className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/40"
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            offInSidebar && "opacity-50",
          )}
        >
          <ProjectIcon icon={project.icon} name={project.title} />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            offInSidebar ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {project.title}
        </span>
        <Select
          value={state}
          onValueChange={(value) => setState(project.id, value as RowState)}
        >
          <SelectTrigger size="xs" aria-label={project.title}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="pinned">
              {t("sidebar.customize.statePinned")}
            </SelectItem>
            {/* In a hidden folder, "no decision" means hidden with it. */}
            <SelectItem value="shown">
              {t(
                folderHidden
                  ? "sidebar.customize.stateWithFolder"
                  : "sidebar.customize.stateShown",
              )}
            </SelectItem>
            <SelectItem value="hidden">
              {t("sidebar.customize.stateHidden")}
            </SelectItem>
          </SelectContent>
        </Select>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={t("sidebar.customize.projectOptions")}>
                <DotsHorizontal size={14} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {t("sidebar.projects.moveTo")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {folders.map((target) => (
                    <DropdownMenuItem
                      key={target.id}
                      disabled={target.id === folder?.id}
                      onSelect={() => onMove(project.id, target.id)}
                    >
                      {target.name}
                    </DropdownMenuItem>
                  ))}
                  {folder && (
                    <DropdownMenuItem onSelect={() => onMove(project.id, null)}>
                      {t("sidebar.projects.noFolder")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() =>
                      onRequestFolderName({
                        kind: "create",
                        projectId: project.id,
                      })
                    }
                  >
                    {t("sidebar.projects.newFolder")}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("sidebar.projects.customize")}</DialogTitle>
          <DialogDescription>
            {t("sidebar.customize.description")}
          </DialogDescription>
        </DialogHeader>

        {canManage && (
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onRequestFolderName({ kind: "create" })}
            >
              <Plus size={14} />
              {t("sidebar.projects.newFolder")}
            </Button>
          </div>
        )}

        <div className="-mx-2 flex min-h-0 flex-col gap-5 overflow-y-auto px-2">
          {folders.map((folder) => {
            const isHidden = hiddenFolders.has(folder.id);
            const inside = folder.projectIds
              .map((id) => byId.get(id))
              .filter((p): p is VirtualMCPEntity => !!p);
            return (
              <Group
                key={folder.id}
                title={folder.name}
                dimmed={isHidden}
                actions={
                  <>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      {t("sidebar.customize.showInSidebar")}
                      <Switch
                        checked={!isHidden}
                        onCheckedChange={(on) => onHideFolder(folder.id, !on)}
                      />
                    </label>
                    {canManage && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            label={t("sidebar.customize.folderOptions")}
                          >
                            <DotsHorizontal size={14} />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              onRequestFolderName({
                                kind: "rename",
                                folderId: folder.id,
                                name: folder.name,
                              })
                            }
                          >
                            {t("sidebar.projects.renameFolder")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => onDeleteFolder(folder.id)}
                          >
                            {t("sidebar.projects.deleteFolder")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </>
                }
              >
                {inside.length === 0 ? (
                  <li className="px-2 py-1.5 text-sm text-muted-foreground">
                    {t("sidebar.customize.empty")}
                  </li>
                ) : (
                  inside.map((project) => row(project, folder))
                )}
              </Group>
            );
          })}
          <Group title={t("sidebar.projects.noFolder")}>
            {projects
              .filter((p) => !placed.has(p.id))
              .map((project) => row(project, null))}
          </Group>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Group({
  title,
  dimmed,
  actions,
  children,
}: {
  title: string;
  dimmed?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex h-8 items-center gap-2 border-b border-border/70 px-2 pb-1">
        <Folder size={14} className="shrink-0 text-muted-foreground" />
        <h3
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            dimmed ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </h3>
        {actions}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

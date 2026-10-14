/** Customize sidebar: a card per folder, a checkbox per project, pin apart. */

import type { ReactNode } from "react";
import { DotsHorizontal, Pin02, Plus } from "@untitledui/icons";
import type {
  ProjectFolder,
  SidebarPreferences,
} from "@decocms/shared/project-sidebar";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
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
import { Switch } from "@decocms/ui/components/switch.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ProjectIcon } from "@/components/project-icon";
import { useT } from "@/i18n/use-t.ts";
import type { FolderNameRequest } from "./folder-name-dialog";

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

  const row = (project: VirtualMCPEntity, folder: ProjectFolder | null) => {
    const isPinned = pinned.has(project.id);
    /** A hidden folder takes its projects with it; a pin overrides that. */
    const followsFolder =
      folder !== null && hiddenFolders.has(folder.id) && !isPinned;
    const shown = !hidden.has(project.id) && !followsFolder;

    return (
      <li
        key={project.id}
        className="group/row flex h-11 items-center gap-3 px-3 transition-colors hover:bg-accent/40"
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            !shown && "opacity-50",
          )}
        >
          <ProjectIcon icon={project.icon} name={project.title} />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            shown ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {project.title}
        </span>
        {canManage && (
          <span className="opacity-0 transition-opacity group-hover/row:opacity-100 has-[[data-state=open]]:opacity-100">
            <MoveMenu
              project={project}
              folder={folder}
              folders={folders}
              onMove={onMove}
              onRequestFolderName={onRequestFolderName}
            />
          </span>
        )}
        {/* Always visible once pinned, so the row says it; on hover before. */}
        <span
          className={cn(
            "transition-opacity",
            !isPinned && "opacity-0 group-hover/row:opacity-100",
          )}
        >
          <IconButton
            label={t(
              isPinned ? "sidebar.projects.unpin" : "sidebar.projects.pin",
            )}
            variant={isPinned ? "secondary" : "ghost"}
            aria-pressed={isPinned}
            onClick={() => onPin(project.id, !isPinned)}
          >
            {isPinned ? <UnpinIcon /> : <Pin02 size={14} />}
          </IconButton>
        </span>
        <Checkbox
          checked={shown}
          disabled={followsFolder}
          aria-label={`${t("sidebar.customize.showInSidebar")}: ${project.title}`}
          title={
            followsFolder ? t("sidebar.customize.stateWithFolder") : undefined
          }
          onCheckedChange={(on) => onHide(project.id, on !== true)}
        />
      </li>
    );
  };

  const card = (
    key: string,
    title: string,
    folder: ProjectFolder | null,
    list: VirtualMCPEntity[],
  ) => {
    const isHidden = folder !== null && hiddenFolders.has(folder.id);
    return (
      <section key={key} className="flex flex-col gap-2">
        <div className="flex h-7 items-center gap-2">
          <h3
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              isHidden ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
          </h3>
          {folder && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("sidebar.customize.showFolder")}
              <Switch
                checked={!isHidden}
                onCheckedChange={(on) => onHideFolder(folder.id, !on)}
              />
            </label>
          )}
          {folder && canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t("sidebar.customize.folderOptions")}>
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
        </div>
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {list.length === 0 ? (
            <li className="flex h-11 items-center px-3 text-sm text-muted-foreground">
              {t("sidebar.customize.empty")}
            </li>
          ) : (
            list.map((project) => row(project, folder))
          )}
        </ul>
      </section>
    );
  };

  const loose = projects.filter((p) => !placed.has(p.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-5 sm:max-w-2xl"
        /* A list to read first; focusing "New folder" made it look pressed. */
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="flex-row items-center justify-between gap-4 pr-8">
          <DialogTitle>{t("sidebar.projects.customize")}</DialogTitle>
          {canManage && (
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={() => onRequestFolderName({ kind: "create" })}
            >
              <Plus size={14} />
              {t("sidebar.projects.newFolder")}
            </Button>
          )}
        </DialogHeader>

        <div className="-mx-6 flex min-h-0 flex-col gap-6 overflow-y-auto px-6 pb-1">
          {card("loose", t("sidebar.projects.heading"), null, loose)}
          {folders.map((folder) =>
            card(
              folder.id,
              folder.name,
              folder,
              folder.projectIds
                .map((id) => byId.get(id))
                .filter((p): p is VirtualMCPEntity => !!p),
            ),
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MoveMenu({
  project,
  folder,
  folders,
  onMove,
  onRequestFolderName,
}: {
  project: VirtualMCPEntity;
  folder: ProjectFolder | null;
  folders: readonly ProjectFolder[];
  onMove: (projectId: string, folderId: string | null) => void;
  onRequestFolderName: (request: FolderNameRequest) => void;
}): ReactNode {
  const t = useT();
  return (
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
                onRequestFolderName({ kind: "create", projectId: project.id })
              }
            >
              {t("sidebar.projects.newFolder")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The pin struck through, as `EyeOff` strikes the eye; the icon set has no
 *  unpin glyph. */
function UnpinIcon() {
  return (
    <span className="relative flex size-3.5">
      <Pin02 size={14} />
      <svg
        viewBox="0 0 14 14"
        className="absolute inset-0 size-3.5"
        aria-hidden="true"
      >
        <line
          x1="1.5"
          y1="1.5"
          x2="12.5"
          y2="12.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

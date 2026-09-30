/**
 * Folders lead a listing as TILES, not rows: entering one is decided on
 * recognition, where a file is scanned in a column against its neighbours.
 *
 * The count under the name is a real listing, so the folder is in cache by the
 * time it is clicked. Capped (`enabled`) so fifty folders are not fifty
 * requests.
 */

import type { ComponentType, ReactNode, SVGProps } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { FolderIcon, type FolderTone } from "@/components/folder-icon";
import { useOrgFsList } from "@/hooks/use-org-fs";
import { useT } from "@/i18n/use-t.ts";
import { EntryActionsMenu } from "./cards";

/** Past a screenful the count stops being read; the requests do not stop. */
export const FOLDER_COUNT_LIMIT = 24;

/** none / some / full — the number itself is already under the name. */
function sheetsFor(count: number | undefined): number {
  if (!count) return 0;
  if (count <= 2) return 1;
  if (count <= 8) return 2;
  return 3;
}

export function FolderTile({
  name,
  meta,
  glyph,
  tone,
  readOnly,
  overlay,
  badge,
  counts,
  onOpen,
  onShare,
  onDelete,
  draggable,
  onDragStart,
  onContextMenu,
  onDrop,
}: {
  name: string;
  /** What to say under the name when the tile is not counting its own
   *  contents — a volume's own file count, or how long ago it changed. */
  meta?: string;
  glyph?: ComponentType<SVGProps<SVGSVGElement>>;
  tone?: FolderTone;
  readOnly?: boolean;
  /** Drawn over the folder's lower-right — a project's own avatar, on the
   *  folder that holds that project's files. */
  overlay?: ReactNode;
  /** Top-left mark: the shared-folder badge. */
  badge?: ReactNode;
  /** List this folder to count it. Omit for a volume, or when already
   *  known. */
  counts?: { volume: string; path: string; enabled: boolean };
  onOpen: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  const t = useT();
  const listing = useOrgFsList(counts?.volume ?? "", counts?.path ?? "", {
    enabled: !!counts && counts.enabled,
  });
  const count = counts ? listing.data?.length : undefined;
  const subtitle =
    meta ??
    (count === undefined
      ? undefined
      : count === 0
        ? t("library.entries.emptyFolder")
        : count === 1
          ? t("library.entries.itemCount")
          : t("library.entries.itemsCount", { count }));

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
      onDragOver={onDrop ? (e) => e.preventDefault() : undefined}
      onDrop={onDrop}
      className={cn(
        "group/card relative flex cursor-pointer flex-col items-center gap-3 rounded-2xl p-4 text-center",
        "border border-transparent transition-colors hover:border-border hover:bg-accent/40",
      )}
    >
      {badge && <span className="absolute top-3 left-3">{badge}</span>}
      <span className="absolute top-2 right-2">
        <EntryActionsMenu
          label={name}
          onShare={onShare}
          onDelete={onDelete}
          t={t}
        />
      </span>
      <span className="relative">
        <FolderIcon
          glyph={glyph}
          tone={tone}
          readOnly={readOnly}
          sheets={sheetsFor(count)}
          className="size-16 transition-transform duration-200 group-hover/card:-translate-y-0.5"
        />
        {/* Ringed in the page background so the mark reads as sitting ON the
            folder rather than being part of its art. */}
        {overlay && (
          <span className="absolute -right-1 -bottom-0.5 flex rounded-lg ring-2 ring-background">
            {overlay}
          </span>
        )}
      </span>
      <span className="flex w-full min-w-0 flex-col gap-0.5">
        <span
          className="truncate text-sm font-medium text-foreground"
          title={name}
        >
          {name}
        </span>
        {/* Reserves its line whether or not there is a subtitle, so a row of
            tiles has one baseline instead of ragged bottoms. */}
        <span className="h-4 truncate text-xs text-muted-foreground">
          {subtitle ?? ""}
        </span>
      </span>
    </div>
  );
}

/** `auto-fill` so a folder keeps its size and the last row runs short. */
export function FolderTiles({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
      {children}
    </div>
  );
}

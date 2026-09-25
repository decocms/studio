/**
 * The Library's files table.
 *
 * The design system's `Table` — which is where the card surface, the sticky
 * header and the row rules come from. This file adds only what a FILE table
 * needs on top of it: the type mark, the sort controls, and the columns that
 * drop as the panel narrows.
 *
 * Columns drop from the right in the order they cost the least: size, then
 * type, then the timestamp. The name never drops.
 */

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Palette, Zap } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { describeFileType, FileTypeIcon } from "@/components/file-type-icon";
import { FolderIcon } from "@/components/folder-icon";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { EntryActionsMenu, PublicBadge, type PublicState } from "./cards";
import { timeAgo } from "@/lib/format-time";
import {
  formatSize,
  type LibraryEntry,
  type LibraryEntryKind,
  type LibrarySort,
} from "./entries";

/** Column widths, shared by the header and every row so they cannot drift. */
const COL = {
  type: "hidden w-32 @2xl/library:table-cell",
  size: "hidden w-20 text-right @xl/library:table-cell",
  updated: "hidden w-24 text-right @md/library:table-cell",
  menu: "w-10",
} as const;

/** A tinted square for the folders the product understands. The gradient
 *  folder is for folders; a skill and a brand are not one, and drawing them as
 *  one would promise a listing where a preview opens. */
function EntryMark({ kind, name }: { kind: LibraryEntryKind; name: string }) {
  if (kind === "folder") return <FolderIcon className="size-5 shrink-0" />;
  if (kind === "skill" || kind === "brand") {
    const Glyph = kind === "skill" ? Zap : Palette;
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Glyph size={12} />
      </span>
    );
  }
  return <FileTypeIcon filename={name} className="h-5 w-4 shrink-0" />;
}

/** What the Type column says. A folder's type is what it IS to the product,
 *  which is the only reading of "type" that tells you anything about one. */
function typeLabel(entry: LibraryEntry, t: TFunction): string {
  if (entry.kind === "file") return describeFileType(entry.name);
  if (entry.kind === "skill") return t("library.cards.skill");
  if (entry.kind === "brand") return t("library.cards.brand");
  return t("library.entries.folder");
}

export interface EntryRowActions {
  onOpen: () => void;
  onBrowse?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  download?: { url: string; filename: string };
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function EntryRow({
  entry,
  publicState,
  /** Replaces the Type column — the containing folder, in cross-volume feeds. */
  secondary,
  actions,
}: {
  entry: LibraryEntry;
  publicState?: PublicState;
  secondary?: string;
  actions: EntryRowActions;
}) {
  const t = useT();
  const size = formatSize(entry);

  return (
    <TableRow
      className="group/card cursor-pointer hover:bg-accent/40"
      draggable={actions.draggable}
      onClick={actions.onOpen}
      onDragStart={actions.onDragStart}
      onContextMenu={actions.onContextMenu}
    >
      <TableCell className="min-w-0 max-w-0 pl-4">
        <span className="flex min-w-0 items-center gap-2.5">
          <EntryMark kind={entry.kind} name={entry.name} />
          <span className="truncate text-foreground" title={entry.name}>
            {entry.name}
          </span>
          {publicState && <PublicBadge state={publicState} t={t} />}
        </span>
      </TableCell>
      <TableCell
        className={cn(COL.type, "truncate text-muted-foreground")}
        title={secondary}
      >
        {secondary ?? typeLabel(entry, t)}
      </TableCell>
      <TableCell className={cn(COL.size, "tabular-nums text-muted-foreground")}>
        {size ?? ""}
      </TableCell>
      <TableCell
        className={cn(COL.updated, "tabular-nums text-muted-foreground")}
      >
        {timeAgo(entry.updatedAt)}
      </TableCell>
      <TableCell className={cn(COL.menu, "pr-2 text-right")}>
        <EntryActionsMenu
          label={entry.name}
          onBrowse={actions.onBrowse}
          onShare={actions.onShare}
          download={actions.download}
          onDelete={actions.onDelete}
          t={t}
        />
      </TableCell>
    </TableRow>
  );
}

function SortButton({
  label,
  active,
  descending,
  className,
  onClick,
}: {
  label: string;
  active: boolean;
  /** Which way this column orders, so the arrow states the order rather than
   *  just marking the column. Name reads A to Z; the rest read biggest and
   *  newest first, which is what someone asking for them means. */
  descending?: boolean;
  className?: string;
  onClick: () => void;
}) {
  const Arrow = descending ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 truncate font-medium transition-colors hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {label}
      {active && <Arrow size={11} className="shrink-0" />}
    </button>
  );
}

/**
 * The files table: its sortable header and its rows.
 *
 * One component rather than two, because the header's columns only line up
 * with the rows' if they read the same widths inside the same container — and
 * a caller that renders one without the other has a table whose columns lie.
 *
 * Each column sorts one way, the way someone asking for it means. A second
 * click reversing it would double the states to explain for an ordering nobody
 * asks a file manager for.
 */
export function EntryList({
  sort,
  onSort,
  typeLabel: typeHeading,
  children,
}: {
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  /** The second column's heading — "Type", or "Location" in a cross-volume
   *  feed, where every row already knows what it is and not where it lives. */
  typeLabel: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="@container/library min-w-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">
              <SortButton
                label={t("library.library.name")}
                active={sort === "name"}
                onClick={() => onSort("name")}
              />
            </TableHead>
            <TableHead className={COL.type}>{typeHeading}</TableHead>
            <TableHead className={COL.size}>
              <SortButton
                label={t("library.entries.size")}
                active={sort === "size"}
                descending
                className="ml-auto"
                onClick={() => onSort("size")}
              />
            </TableHead>
            <TableHead className={COL.updated}>
              <SortButton
                label={t("library.library.updated")}
                active={sort === "updated"}
                descending
                className="ml-auto"
                onClick={() => onSort("updated")}
              />
            </TableHead>
            <TableHead className={COL.menu} />
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

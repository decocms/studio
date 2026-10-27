/**
 * The Library's files table, on the design system's `Table`. Columns drop from
 * the right — size, then owner, then timestamp. The name never drops.
 */

import { createContext, use, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  File01,
  Folder,
  Palette,
  Zap,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { FileTypeIcon } from "@/components/file-type-icon";
import { FolderIcon } from "@/components/folder-icon";
import { useMembersQuery } from "@/hooks/use-members";
import { useT } from "@/i18n/use-t.ts";
import type { Member } from "@/layouts/task-board/config";
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
  location: "hidden w-32 @2xl/library:table-cell",
  owner: "hidden w-36 @3xl/library:table-cell",
  size: "hidden w-20 text-right @xl/library:table-cell",
  updated: "hidden w-24 text-right @md/library:table-cell",
  menu: "w-10",
} as const;

/** Whether the table has a folder column: a cross-volume feed's. */
const LocationColumn = createContext(false);

/** Context's list: line marks, left-aligned columns, when before where. */
const Plain = createContext(false);

/** Plain's columns are fixed widths and never right-aligned. */
const PLAIN_COL = {
  location: "hidden w-32 @2xl/library:table-cell",
  owner: "hidden w-36 @xl/library:table-cell",
  size: "hidden w-20 @lg/library:table-cell",
  updated: "hidden w-24 @md/library:table-cell",
  menu: "w-10",
} as const;

function PlainMark({ kind }: { kind: LibraryEntryKind }) {
  const Glyph =
    kind === "folder"
      ? Folder
      : kind === "skill"
        ? Zap
        : kind === "brand"
          ? Palette
          : File01;
  return <Glyph size={16} className="shrink-0 text-muted-foreground" />;
}

/** A tinted square for skills and brands: the gradient folder would promise a
 *  listing where a preview opens. */
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

/** Who made it, by face and first name: the full name is in the tooltip. */
function Owner({ userId }: { userId?: string }) {
  const { data } = useMembersQuery({ enabled: !!userId });
  const members: Member[] = data?.data?.members ?? [];
  const member = userId ? members.find((m) => m.userId === userId) : undefined;
  const name = member?.user?.name?.trim();
  if (!name) return null;
  return (
    <span className="flex min-w-0 items-center gap-2" title={name}>
      <Avatar
        url={member?.user?.image ?? undefined}
        fallback={name}
        shape="circle"
        size="2xs"
        className="shrink-0"
      />
      <span className="truncate">{name.split(/\s+/)[0]}</span>
    </span>
  );
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
  /** A folder takes the entries dragged onto it. */
  onDrop?: (e: React.DragEvent) => void;
  /** Opens what the location column names, such as the chat a file came from. */
  onOpenSecondary?: () => void;
}

export function EntryRow({
  entry,
  publicState,
  secondary,
  selected = false,
  actions,
}: {
  entry: LibraryEntry;
  publicState?: PublicState;
  /** The containing folder in a cross-volume feed, or the chat a file came
   *  from in a chat volume. */
  secondary?: string;
  /** Its preview is open beside the list. */
  selected?: boolean;
  actions: EntryRowActions;
}) {
  const t = useT();
  const size = formatSize(entry);
  const showLocation = use(LocationColumn);
  const plain = use(Plain);
  const col = plain ? PLAIN_COL : COL;

  const locationCell = showLocation && (
    <TableCell
      className={cn(col.location, "truncate text-muted-foreground")}
      title={secondary}
    >
      {secondary && actions.onOpenSecondary ? (
        <button
          type="button"
          className="max-w-full truncate hover:text-foreground hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            actions.onOpenSecondary?.();
          }}
        >
          {secondary}
        </button>
      ) : secondary && plain ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <Folder size={14} className="shrink-0" />
          <span className="truncate">{secondary}</span>
        </span>
      ) : (
        secondary
      )}
    </TableCell>
  );
  const ownerCell = (
    <TableCell
      className={cn(
        col.owner,
        plain ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Owner userId={entry.entry.createdBy} />
    </TableCell>
  );
  const sizeCell = (
    <TableCell className={cn(col.size, "tabular-nums text-muted-foreground")}>
      {size ?? ""}
    </TableCell>
  );
  const updatedCell = (
    <TableCell
      className={cn(col.updated, "tabular-nums text-muted-foreground")}
    >
      {timeAgo(entry.updatedAt)}
    </TableCell>
  );

  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      aria-selected={selected}
      className="group/card cursor-pointer hover:bg-accent"
      draggable={actions.draggable}
      onClick={actions.onOpen}
      onDragStart={actions.onDragStart}
      onContextMenu={actions.onContextMenu}
      onDragOver={actions.onDrop ? (e) => e.preventDefault() : undefined}
      onDrop={actions.onDrop}
    >
      <TableCell className="min-w-0 max-w-0 pl-4">
        <span className="flex min-w-0 items-center gap-2.5">
          {plain ? (
            <PlainMark kind={entry.kind} />
          ) : (
            <EntryMark kind={entry.kind} name={entry.name} />
          )}
          <span
            className={cn("truncate text-foreground", plain && "font-medium")}
            title={entry.name}
          >
            {entry.name}
          </span>
          {publicState && <PublicBadge state={publicState} t={t} />}
        </span>
      </TableCell>
      {plain ? (
        <>
          {updatedCell}
          {sizeCell}
          {ownerCell}
          {locationCell}
        </>
      ) : (
        <>
          {locationCell}
          {ownerCell}
          {sizeCell}
          {updatedCell}
        </>
      )}
      <TableCell className={cn(col.menu, "pr-2 text-right")}>
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
  /** Name reads A to Z; the rest read biggest and newest first, so the arrow
   *  states the order rather than just marking the column. */
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
 * Header and rows in one component: their columns only line up if they read the
 * same widths inside the same container. Each column sorts one way.
 */
export function EntryList({
  sort,
  onSort,
  locationLabel,
  plain = false,
  children,
}: {
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  /** Names the folder column of a cross-volume feed; omitted in a folder. */
  locationLabel?: string;
  /** Context's list, on the page itself rather than a card. */
  plain?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const col = plain ? PLAIN_COL : COL;
  const align = plain ? "font-normal" : "ml-auto";
  const locationHead = locationLabel && (
    <TableHead className={col.location}>{locationLabel}</TableHead>
  );
  const ownerHead = (
    <TableHead className={col.owner}>
      {t("library.entries.createdBy")}
    </TableHead>
  );
  const sizeHead = (
    <TableHead className={col.size}>
      <SortButton
        label={t("library.entries.size")}
        active={sort === "size"}
        descending
        className={align}
        onClick={() => onSort("size")}
      />
    </TableHead>
  );
  const updatedHead = (
    <TableHead className={col.updated}>
      <SortButton
        label={t("library.library.updated")}
        active={sort === "updated"}
        descending
        className={align}
        onClick={() => onSort("updated")}
      />
    </TableHead>
  );
  return (
    <div className="@container/library min-w-0">
      <Table className={cn(plain && "table-fixed")}>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">
              <SortButton
                label={t("library.library.name")}
                active={sort === "name"}
                className={cn(plain && "font-normal")}
                onClick={() => onSort("name")}
              />
            </TableHead>
            {plain ? (
              <>
                {updatedHead}
                {sizeHead}
                {ownerHead}
                {locationHead}
              </>
            ) : (
              <>
                {locationHead}
                {ownerHead}
                {sizeHead}
                {updatedHead}
              </>
            )}
            <TableHead className={col.menu} />
          </TableRow>
        </TableHeader>
        <TableBody>
          <Plain value={plain}>
            <LocationColumn value={!!locationLabel}>{children}</LocationColumn>
          </Plain>
        </TableBody>
      </Table>
    </div>
  );
}

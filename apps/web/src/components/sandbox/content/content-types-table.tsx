import { Plus } from "@untitledui/icons";
import { useState } from "react";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { TableColumn } from "@/components/collections/collection-table.tsx";
import { CollectionTableWrapper } from "@/components/collections/collection-table-wrapper.tsx";
import { SITE_DRAFT_VIEW_INSET } from "@/components/site-draft-bar/view-header";
import { useT } from "@/i18n/use-t.ts";
import {
  type ContentEntry,
  type ContentType,
  type ContentTypeTree,
  type EntryStatus,
  entryMatches,
  entryName,
  foldSameDestination,
  humanizeTypeKey,
  inRedirectPathGroup,
  pagePathOf,
  pageSectionCount,
  redirectDestinationPage,
  redirectPathGroups,
  redirectRowOf,
  summaryFieldsOf,
  summaryValue,
} from "./content-types";
import { CMS_SETTINGS_RESOLVE_TYPE } from "./cms-settings";
import { useTypeLabel } from "./content-types-sidebar";
import { EmptyMessage } from "./empty-message";

type Row = { type: ContentType; entry: ContentEntry };

/** A draft status as the Content tab's blog posts show theirs. */
const STATUS_VARIANT = {
  published: "success",
  changed: "warning",
  new: "info",
  deleted: "destructive",
} as const satisfies Record<EntryStatus, string>;

const STATUS_LABEL = {
  published: "siteEditor.contentTypes.status.published",
  changed: "siteEditor.contentTypes.status.changed",
  new: "siteEditor.contentTypes.status.new",
  deleted: "siteEditor.contentTypes.status.deleted",
} as const satisfies Record<EntryStatus, string>;

/**
 * A content type's entries (or every changed entry, for "Changes in draft")
 * as a text-only table: no previews, nothing rendered. Each row says its
 * status in the draft; a deleted one can be restored. A row opens the
 * entry's editor.
 */
export function ContentTypesTable({
  tree,
  type,
  onOpen,
  onRestore,
  restoring,
  createLabel,
  onCreate,
  rowMenu,
}: {
  tree: ContentTypeTree;
  /** `null`: the draft's changes, across types. */
  type: ContentType | null;
  onOpen: (type: ContentType, entry: ContentEntry) => void;
  onRestore: (entry: ContentEntry) => void;
  /** The entry whose restore is in flight. */
  restoring: string | null;
  createLabel?: string;
  onCreate?: () => void;
  rowMenu?: (type: ContentType, entry: ContentEntry) => React.ReactNode;
}) {
  const t = useT();
  const label = useTypeLabel();
  const [query, setQuery] = useState("");
  // "all", "changed", or a redirect folder ("path:products"; "path:": the rest).
  const [filter, setFilter] = useState("all");
  const [unfolded, setUnfolded] = useState(false);
  const known = tree.statusKnown;
  const rows: Row[] = type
    ? type.entries.map((entry) => ({ type, entry }))
    : tree.changed;
  const fields = type ? summaryFieldsOf(type) : [];
  const changedCount = rows.filter(
    (r) => r.entry.status !== "published",
  ).length;
  const pathGroups =
    type?.group === "redirects" ? redirectPathGroups(type.entries) : [];
  const onlyChanged = filter === "changed" && known;
  const pathFilter = filter.startsWith("path:") ? filter.slice(5) : null;
  const matching = rows.filter(
    (r) =>
      (!onlyChanged || r.entry.status !== "published") &&
      (pathFilter === null ||
        inRedirectPathGroup(r.entry, pathFilter, pathGroups)) &&
      entryMatches(r.entry, query, type ? fields : []),
  );
  // A long list of redirects to one page folds, unless searched or filtered.
  const fold =
    type?.group === "redirects" &&
    filter === "all" &&
    !query.trim() &&
    !unfolded
      ? foldSameDestination(matching.map((r) => r.entry))
      : null;
  const kept = fold && fold.folded > 0 ? new Set(fold.shown) : null;
  const shown = kept ? matching.filter((r) => kept.has(r.entry)) : matching;
  const singletons = new Set(tree.singletons.map((t) => t.id));
  // A type with one entry is named by its type, as the sidebar names it.
  // The CMS settings are the site's Settings, as their own part names them.
  const nameOf = ({ type: rowType, entry }: Row) =>
    rowType.id === CMS_SETTINGS_RESOLVE_TYPE
      ? t("siteEditor.contentTypes.settings")
      : singletons.has(rowType.id) && typeof entry.block.name !== "string"
        ? label(rowType)
        : entryName(entry);
  const kind = !type
    ? "changes"
    : type.group === "pages"
      ? "pages"
      : type.group === "redirects"
        ? "redirects"
        : "other";
  const pages = tree.pages?.entries ?? [];
  const typeName = type
    ? label(type)
    : t("siteEditor.contentTypes.changesInDraft");
  const searchLabel =
    kind === "redirects"
      ? t("siteEditor.contentTypes.searchRedirects")
      : t("siteEditor.contentTypes.search", {
          type: typeName.toLowerCase(),
        });

  const deleted = (row: Row) => row.entry.status === "deleted";
  const opens = (row: Row) => !deleted(row) && !row.entry.orphan;
  /** A row's text, struck through once the draft deletes it. */
  const text = (row: Row, value: React.ReactNode, muted = false) => (
    <span
      className={cn(
        (muted || deleted(row)) && "text-muted-foreground",
        deleted(row) && "line-through",
      )}
    >
      {value}
    </span>
  );
  const redirectOf = (row: Row) =>
    row.type.group === "redirects" ? redirectRowOf(row.entry) : null;

  const columns: TableColumn<Row>[] = [];
  if (kind === "redirects") {
    columns.push(
      {
        id: "from",
        header: t("siteEditor.contentTypes.column.from"),
        render: (row) => text(row, redirectOf(row)?.from),
      },
      {
        id: "to",
        header: t("siteEditor.contentTypes.column.to"),
        render: (row) => {
          const to = redirectOf(row)?.to ?? "";
          const page = redirectDestinationPage(pages, to);
          return (
            <span className="flex min-w-0 items-baseline gap-2">
              {page && text(row, entryName(page))}
              {text(row, to, true)}
            </span>
          );
        },
      },
      {
        id: "kind",
        header: t("siteEditor.contentTypes.column.kind"),
        render: (row) =>
          redirectOf(row)?.kind === "permanent"
            ? t("siteEditor.contentTypes.kind.permanent")
            : t("siteEditor.contentTypes.kind.temporary"),
      },
    );
  } else {
    columns.push({
      id: "name",
      header: t("siteEditor.contentTypes.column.name"),
      render: (row) => text(row, nameOf(row)),
    });
    if (kind === "pages") {
      columns.push(
        {
          id: "path",
          header: t("siteEditor.contentTypes.column.path"),
          render: (row) => text(row, pagePathOf(row.entry), true),
        },
        {
          id: "sections",
          header: t("siteEditor.contentTypes.column.sections"),
          render: (row) => pageSectionCount(row.entry),
        },
      );
    }
    if (kind === "changes") {
      columns.push({
        id: "type",
        header: t("siteEditor.contentTypes.column.type"),
        render: (row) => (row.type.title ? label(row.type) : ""),
      });
    }
    if (kind === "other") {
      for (const field of fields) {
        columns.push({
          id: `field:${field}`,
          header: humanizeTypeKey(field),
          render: (row) => text(row, summaryValue(row.entry, field)),
        });
      }
    }
  }
  columns.push({
    id: "status",
    header: t("siteEditor.contentTypes.column.status"),
    render: (row) =>
      known ? (
        <span className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[row.entry.status]}>
            {t(STATUS_LABEL[row.entry.status])}
          </Badge>
          {deleted(row) && (
            <Stop>
              <Button
                size="xs"
                variant="outline"
                disabled={restoring !== null}
                onClick={() => onRestore(row.entry)}
              >
                {restoring === row.entry.key && <Spinner className="size-3" />}
                {t("siteEditor.contentTypes.restore")}
              </Button>
            </Stop>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">
          {t("siteEditor.contentTypes.status.checking")}
        </span>
      ),
  });
  if (rowMenu) {
    columns.push({
      id: "actions",
      header: "",
      render: (row) =>
        deleted(row) ? null : <Stop>{rowMenu(row.type, row.entry)}</Stop>,
      cellClassName: "w-12 shrink-0",
    });
  }

  // "/" focuses the search, unless the person is typing somewhere else.
  // A ref callback with cleanup, as the house bans useEffect.
  const searchRef = (box: HTMLDivElement | null) => {
    const input = box?.querySelector("input");
    if (!input) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      input.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  };

  const emptyMessage = query.trim()
    ? t("siteEditor.contentTypes.noMatch")
    : !type
      ? t("siteEditor.contentTypes.noChanges")
      : filter === "changed"
        ? t("siteEditor.contentTypes.noChangedHere")
        : t("siteEditor.contentTypes.empty");

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto">
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-2",
          SITE_DRAFT_VIEW_INSET,
        )}
      >
        <div ref={searchRef} className="w-full max-w-[280px]">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={searchLabel}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
          />
        </div>
        {type && (
          <ToggleGroup
            type="single"
            variant="segmented"
            size="sm"
            value={filter}
            onValueChange={(next) => next && setFilter(next)}
            aria-label={t("siteEditor.contentTypes.filter")}
          >
            <ToggleGroupItem value="all">
              {t("siteEditor.contentTypes.filter.all", { count: rows.length })}
            </ToggleGroupItem>
            {/* Until the draft's changes are read, none is claimed. */}
            {known && (
              <ToggleGroupItem value="changed">
                {t("siteEditor.contentTypes.filter.changed", {
                  count: changedCount,
                })}
              </ToggleGroupItem>
            )}
            {pathGroups.map((group) => (
              <ToggleGroupItem
                key={group.segment || "-"}
                value={`path:${group.segment}`}
              >
                {group.segment
                  ? `${humanizeTypeKey(group.segment)} ${group.count}`
                  : t("siteEditor.contentTypes.filter.otherPaths", {
                      count: group.count,
                    })}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {onCreate && createLabel && (
          <Button size="sm" className="ml-auto" onClick={onCreate}>
            <Plus size={16} />
            {createLabel}
          </Button>
        )}
      </div>

      <div className="flex flex-1 flex-col px-4 pb-4">
        <CollectionTableWrapper
          columns={columns}
          data={shown}
          onRowClick={(row) => onOpen(row.type, row.entry)}
          isRowClickable={opens}
          emptyState={<EmptyMessage title={emptyMessage} />}
        />
        {fold && fold.folded > 0 && (
          <div className="py-2">
            <Button variant="ghost" size="sm" onClick={() => setUnfolded(true)}>
              {t("siteEditor.contentTypes.folded", { count: fold.folded })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A control inside a row: its clicks and keys never open the row. */
function Stop({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </span>
  );
}

import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  type ContentEntry,
  type ContentType,
  type ContentTypeTree,
  type EntryStatus,
  entryMatches,
  entryName,
  humanizeTypeKey,
  pagePathOf,
  pageSectionCount,
  redirectDestinationPage,
  redirectRowOf,
  summaryFieldsOf,
  summaryValue,
} from "./content-types";
import { useTypeLabel } from "./content-types-sidebar";

/** "New in draft" has no theme token: a mid-tone blue that reads on both. */
const NEW_DOT = "oklch(0.64 0.13 245)";

type Row = { type: ContentType; entry: ContentEntry };

/**
 * A content type's entries (or every changed entry, for "Changes in draft")
 * as a dense text-only table: no previews, nothing rendered. Each row says
 * its status in the draft; a deleted one can be restored. A row opens the
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
  const [onlyChanged, setOnlyChanged] = useState(false);
  const rows: Row[] = type
    ? type.entries.map((entry) => ({ type, entry }))
    : tree.changed;
  const fields = type ? summaryFieldsOf(type) : [];
  const changedCount = rows.filter(
    (r) => r.entry.status !== "published",
  ).length;
  const shown = rows.filter(
    (r) =>
      (!onlyChanged || r.entry.status !== "published") &&
      entryMatches(r.entry, query, type ? fields : []),
  );
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
  const searchLabel = t("siteEditor.contentTypes.search", {
    type: typeName.toLowerCase(),
  });

  // "/" focuses the search, unless the person is typing somewhere else.
  const searchRef = (input: HTMLInputElement | null) => {
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

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto px-8 py-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative flex w-full max-w-[280px]">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="w-full rounded-lg bg-muted/60 py-1.5 pr-9 pl-3 text-[13px] outline-none placeholder:text-muted-foreground"
          />
          <kbd className="pointer-events-none absolute top-1.5 right-2 rounded border bg-background px-1.5 text-[11px] text-muted-foreground">
            /
          </kbd>
        </div>
        {type && (
          <div
            role="group"
            aria-label={t("siteEditor.contentTypes.filter")}
            className="flex gap-0.5"
          >
            <FilterPill
              active={!onlyChanged}
              onClick={() => setOnlyChanged(false)}
              label={t("siteEditor.contentTypes.filter.all", {
                count: rows.length,
              })}
            />
            <FilterPill
              active={onlyChanged}
              onClick={() => setOnlyChanged(true)}
              label={t("siteEditor.contentTypes.filter.changed", {
                count: changedCount,
              })}
            />
          </div>
        )}
        {onCreate && createLabel && (
          <Button size="sm" className="ml-auto" onClick={onCreate}>
            {createLabel}
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {query.trim()
            ? t("siteEditor.contentTypes.noMatch")
            : !type
              ? t("siteEditor.contentTypes.noChanges")
              : onlyChanged
                ? t("siteEditor.contentTypes.noChangedHere")
                : t("siteEditor.contentTypes.empty")}
        </p>
      ) : (
        <Table variant="flush" className="min-w-[560px]">
          <TableHeader className="bg-background">
            <TableRow className="border-b-0 hover:bg-transparent">
              {kind === "redirects" ? (
                <>
                  <Head>{t("siteEditor.contentTypes.column.from")}</Head>
                  <Head>{t("siteEditor.contentTypes.column.to")}</Head>
                  <Head>{t("siteEditor.contentTypes.column.kind")}</Head>
                </>
              ) : (
                <>
                  <Head>{t("siteEditor.contentTypes.column.name")}</Head>
                  {kind === "pages" && (
                    <>
                      <Head>{t("siteEditor.contentTypes.column.path")}</Head>
                      <Head>
                        {t("siteEditor.contentTypes.column.sections")}
                      </Head>
                    </>
                  )}
                  {kind === "changes" && (
                    <Head>{t("siteEditor.contentTypes.column.type")}</Head>
                  )}
                  {kind === "other" &&
                    fields.map((field) => (
                      <Head key={field}>{humanizeTypeKey(field)}</Head>
                    ))}
                </>
              )}
              <Head>{t("siteEditor.contentTypes.column.status")}</Head>
              {rowMenu && <Head className="w-8" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map(({ type: rowType, entry }) => {
              const deleted = entry.status === "deleted";
              const struck = cn(deleted && "line-through opacity-50");
              const redirect =
                rowType.group === "redirects" ? redirectRowOf(entry) : null;
              const destination = redirect
                ? redirectDestinationPage(pages, redirect.to)
                : null;
              return (
                <TableRow
                  key={`${rowType.id}:${entry.key}`}
                  onClick={deleted ? undefined : () => onOpen(rowType, entry)}
                  className={cn(
                    "group border-border/50",
                    !deleted && "cursor-pointer hover:bg-accent/50",
                  )}
                >
                  {kind === "redirects" && redirect ? (
                    <>
                      <Cell>
                        <span className={cn("font-mono text-[13px]", struck)}>
                          {redirect.from}
                        </span>
                      </Cell>
                      <Cell>
                        <div className={cn("flex flex-col", struck)}>
                          {destination && <span>{entryName(destination)}</span>}
                          <span className="font-mono text-xs text-muted-foreground">
                            {redirect.to}
                          </span>
                        </div>
                      </Cell>
                      <Cell className="text-muted-foreground">
                        {redirect.kind === "permanent"
                          ? t("siteEditor.contentTypes.kind.permanent")
                          : t("siteEditor.contentTypes.kind.temporary")}
                      </Cell>
                    </>
                  ) : (
                    <>
                      <Cell>
                        <span className={cn("font-medium", struck)}>
                          {entryName(entry)}
                        </span>
                      </Cell>
                      {kind === "pages" && (
                        <>
                          <Cell>
                            <span
                              className={cn(
                                "font-mono text-[13px] text-muted-foreground",
                                struck,
                              )}
                            >
                              {pagePathOf(entry)}
                            </span>
                          </Cell>
                          <Cell className="text-muted-foreground tabular-nums">
                            {pageSectionCount(entry)}
                          </Cell>
                        </>
                      )}
                      {kind === "changes" && (
                        <Cell className="text-muted-foreground">
                          {label(rowType)}
                        </Cell>
                      )}
                      {kind === "other" &&
                        fields.map((field) => (
                          <Cell
                            key={field}
                            className="max-w-[320px] truncate text-muted-foreground"
                          >
                            <span className={struck}>
                              {summaryValue(entry, field)}
                            </span>
                          </Cell>
                        ))}
                    </>
                  )}
                  <Cell>
                    <span className="inline-flex items-center gap-2">
                      <StatusLabel status={entry.status} />
                      {deleted && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={restoring !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRestore(entry);
                          }}
                        >
                          {restoring === entry.key ? (
                            <Spinner className="size-3" />
                          ) : null}
                          {t("siteEditor.contentTypes.restore")}
                        </Button>
                      )}
                    </span>
                  </Cell>
                  {rowMenu && (
                    <Cell className="w-8 text-right">
                      {!deleted && (
                        <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                          {rowMenu(rowType, entry)}
                        </span>
                      )}
                    </Cell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function Head({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <TableHead
      className={cn(
        "h-8 px-3 text-xs font-normal text-muted-foreground/80",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

function Cell({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <TableCell className={cn("px-3 py-2", className)}>{children}</TableCell>
  );
}

function FilterPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-[13px] cursor-pointer",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/** A colored dot and the status in words. */
function StatusLabel({ status }: { status: EntryStatus }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-2 text-foreground/80">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          status === "published" && "bg-success",
          status === "changed" && "bg-warning",
          status === "deleted" && "bg-destructive",
        )}
        style={status === "new" ? { background: NEW_DOT } : undefined}
      />
      {status === "published"
        ? t("siteEditor.contentTypes.status.published")
        : status === "changed"
          ? t("siteEditor.contentTypes.status.changed")
          : status === "new"
            ? t("siteEditor.contentTypes.status.new")
            : t("siteEditor.contentTypes.status.deleted")}
    </span>
  );
}

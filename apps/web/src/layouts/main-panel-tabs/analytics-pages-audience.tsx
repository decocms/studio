/**
 * "Pages by audience" — the site's CMS pages ranked by visitors, at the top of
 * Analytics → Pages & sources. A template page (`/:slug/p`) sums the URLs it
 * serves and opens into its top URLs; paths with traffic that no CMS page
 * serves (checkout, proxied routes) are listed apart as "Other routes". Each
 * page opens in the site editor.
 *
 * Visitors per path come from the read surface's `pages` view through the
 * hosting BFF (tenant-scoped like every other view); the pages come from the
 * site's decofile, read the way the site editor reads it.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Edit02 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import {
  extractPages,
  type PageEntry,
} from "@/components/sections-editor/page-list";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import {
  groupPathsByPage,
  readPathAudience,
  sortPageAudience,
  type PageAudience,
  type PagesSortKey,
  type PathAudience,
} from "./analytics-pages";
import { usePanelNavigate } from "./use-panel-navigate";

/** Rows shown before "Show all": enough to cover what carries the audience. */
const PAGE_ROWS = 25;
const OTHER_ROWS = 10;
const TEMPLATE_URLS = 10;

const fmt = (n: number | undefined) =>
  n === undefined ? "—" : n > 0 ? n.toLocaleString() : "–";

/** The site's CMS pages, from the draft the editor reads (`null` = unknown). */
function useCmsPages(): { pages: PageEntry[] | null; loading: boolean } {
  const { org } = useProjectContext();
  const virtualMcpId = useRouteVirtualMcpId();
  const task = useOptionalChatTask();
  const branch = task?.currentBranch ?? null;
  const params = branch
    ? {
        orgSlug: org.slug,
        virtualMcpId,
        branch,
        threadId: task?.taskId ?? null,
        previewUrl: null,
      }
    : null;
  // Never boots a dev server: committed content, the content protocol, or
  // Fast Preview's branch read — whichever this site has.
  const decofile = useDecofile(params, { fetchEnabled: false });
  const meta = useLiveMeta(params, { fetchEnabled: false });
  const data = decofile.data as Record<string, unknown> | undefined;
  if (decofile.isLoading || (data && meta.isLoading)) {
    return { pages: null, loading: true };
  }
  return { pages: data ? extractPages(data, meta.data) : null, loading: false };
}

function usePathAudience(
  base: string,
  orgSlug: string,
  site: string,
  range: string,
) {
  return useQuery({
    queryKey: KEYS.analyticsData(orgSlug, site, "pages", range),
    queryFn: async (): Promise<PathAudience[]> => {
      const res = await fetch(
        `${base}/analytics/data?view=pages&range=${encodeURIComponent(range)}`,
      );
      if (!res.ok) throw new Error(`analytics request failed (${res.status})`);
      const body = (await res.json()) as { data?: unknown };
      return readPathAudience(body.data);
    },
    retry: false,
    staleTime: 30_000,
  });
}

function SortHead({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: PagesSortKey;
  sort: { key: PagesSortKey; dir: 1 | -1 };
  onSort: (key: PagesSortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead
      className={className}
      aria-sort={
        active ? (sort.dir === 1 ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        <span aria-hidden className="w-2 text-2xs">
          {active ? (sort.dir === 1 ? "▲" : "▼") : ""}
        </span>
      </button>
    </TableHead>
  );
}

/** Visitors over a thin share bar, scaled to the top row. */
function VisitorsCell({ value, max }: { value: number; max: number }) {
  return (
    <TableCell className="w-20 text-right tabular-nums sm:w-28">
      <div className="ml-auto flex w-14 flex-col items-end gap-1 sm:w-20">
        <span>{fmt(value)}</span>
        <span aria-hidden className="h-1 w-full rounded-full bg-muted">
          {value > 0 && (
            <span
              className="ml-auto block h-full rounded-full bg-[var(--chart-1)]"
              style={{ width: `${Math.max(3, (value / max) * 100)}%` }}
            />
          )}
        </span>
      </div>
    </TableCell>
  );
}

function PageRow({
  row,
  max,
  showPageviews,
  onEdit,
}: {
  row: PageAudience;
  max: number;
  showPageviews: boolean;
  onEdit: (page: PageEntry, path?: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const expandable = row.template && row.urls.length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <TableRow>
        <TableCell className="w-full max-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            {expandable ? (
              <button
                type="button"
                aria-expanded={open}
                aria-label={t("mainPanelTabs.analyticsTab.pagesShowUrls", {
                  name: row.page.name,
                })}
                onClick={() => setOpen((o) => !o)}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Chevron className="size-3.5" />
              </button>
            ) : (
              <span className="size-5 shrink-0" />
            )}
            <div className="flex min-w-0 flex-col">
              <span
                className="truncate font-medium text-foreground"
                title={row.page.name}
              >
                {row.page.name}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate font-mono" title={row.page.path}>
                  {row.page.path}
                </span>
                {row.template && (
                  <span
                    className="shrink-0"
                    title={t("mainPanelTabs.analyticsTab.pagesTemplateHint")}
                  >
                    {"· "}
                    {t("mainPanelTabs.analyticsTab.pagesTemplateUrls", {
                      count: row.urls.length.toLocaleString(),
                    })}
                  </span>
                )}
              </span>
            </div>
          </div>
        </TableCell>
        <VisitorsCell value={row.visitors} max={max} />
        {showPageviews && (
          <TableCell className="hidden w-28 text-right tabular-nums text-muted-foreground sm:table-cell">
            {fmt(row.pageviews)}
          </TableCell>
        )}
        <TableCell className="w-px text-right">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("mainPanelTabs.analyticsTab.pagesEditAria", {
              name: row.page.name,
            })}
            onClick={() => onEdit(row.page)}
          >
            <Edit02 className="size-3.5" />
            <span className="hidden sm:inline">
              {t("mainPanelTabs.analyticsTab.pagesEdit")}
            </span>
          </Button>
        </TableCell>
      </TableRow>
      {open &&
        row.urls.slice(0, TEMPLATE_URLS).map((url) => (
          <TableRow key={url.path} className="bg-muted/30">
            <TableCell className="w-full max-w-0 pl-9">
              <span
                className="block truncate font-mono text-xs text-foreground"
                title={url.path}
              >
                {url.path}
              </span>
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">
              {fmt(url.visitors)}
            </TableCell>
            {showPageviews && (
              <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground sm:table-cell">
                {fmt(url.pageviews)}
              </TableCell>
            )}
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("mainPanelTabs.analyticsTab.pagesEditAria", {
                  name: url.path,
                })}
                onClick={() => onEdit(row.page, url.path)}
              >
                <Edit02 className="size-3.5" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      {open && row.urls.length > TEMPLATE_URLS && (
        <TableRow className="bg-muted/30">
          <TableCell
            colSpan={showPageviews ? 4 : 3}
            className="pl-9 text-xs text-muted-foreground"
          >
            {t("mainPanelTabs.analyticsTab.pagesMoreUrls", {
              count: (row.urls.length - TEMPLATE_URLS).toLocaleString(),
            })}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ShowAll({
  total,
  limit,
  all,
  onToggle,
}: {
  total: number;
  limit: number;
  all: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  if (total <= limit) return null;
  return (
    <div className="border-t border-border px-4 py-2">
      <Button variant="ghost" size="sm" onClick={onToggle}>
        {all
          ? t("mainPanelTabs.analyticsTab.pagesShowLess")
          : t("mainPanelTabs.analyticsTab.pagesShowAll", {
              count: total.toLocaleString(),
            })}
      </Button>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface overflow-hidden">
      <header className="flex flex-col gap-0.5 border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

export function PagesAudience({
  base,
  orgSlug,
  site,
  range,
}: {
  base: string;
  orgSlug: string;
  site: string;
  range: string;
}) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  const audience = usePathAudience(base, orgSlug, site, range);
  const cms = useCmsPages();
  const [sort, setSort] = useState<{ key: PagesSortKey; dir: 1 | -1 }>({
    key: "visitors",
    dir: -1,
  });
  const [allPages, setAllPages] = useState(false);
  const [allOther, setAllOther] = useState(false);

  const title = t("mainPanelTabs.analyticsTab.pagesTitle");
  const subtitle = t("mainPanelTabs.analyticsTab.pagesSubtitle");

  if (audience.isLoading || cms.loading) {
    return (
      <Section title={title} subtitle={subtitle}>
        <div className="flex flex-col gap-2 p-4" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </Section>
    );
  }
  if (audience.isError) {
    return (
      <Section title={title} subtitle={subtitle}>
        <div className="flex items-center justify-between gap-3 px-4 py-6">
          <p className="text-sm text-muted-foreground">
            {t("mainPanelTabs.analyticsTab.pagesLoadError")}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void audience.refetch()}
          >
            {t("mainPanelTabs.analyticsTab.pagesRetry")}
          </Button>
        </div>
      </Section>
    );
  }
  const paths = audience.data ?? [];
  if (paths.length === 0) {
    return (
      <Section title={title} subtitle={subtitle}>
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.pagesEmpty")}
        </p>
      </Section>
    );
  }

  const grouped = groupPathsByPage(cms.pages ?? [], paths);
  const rows = sortPageAudience(grouped.pages, sort.key, sort.dir);
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  const otherMax = Math.max(1, ...grouped.other.map((r) => r.visitors));
  const showPageviews = grouped.hasPageviews;
  const onSort = (key: PagesSortKey) =>
    setSort((s) => ({
      key,
      dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1,
    }));
  const onEdit = (page: PageEntry, path?: string) =>
    openPanel("content", {
      search: (prev) => ({
        ...prev,
        contentPageId: page.key,
        ...(path ? { contentPath: path } : {}),
      }),
    });
  const visibleRows = allPages ? rows : rows.slice(0, PAGE_ROWS);
  const visibleOther = allOther
    ? grouped.other
    : grouped.other.slice(0, OTHER_ROWS);

  return (
    <div className="flex flex-col gap-4">
      {rows.length > 0 && (
        <Section title={title} subtitle={subtitle}>
          <Table variant="flush">
            <TableHeader>
              <TableRow>
                <SortHead
                  label={t("mainPanelTabs.analyticsTab.pagesColPage")}
                  sortKey="name"
                  sort={sort}
                  onSort={onSort}
                  className="pl-4"
                />
                <SortHead
                  label={t("mainPanelTabs.analyticsTab.pagesColVisitors")}
                  sortKey="visitors"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                {showPageviews && (
                  <SortHead
                    label={t("mainPanelTabs.analyticsTab.pagesColPageviews")}
                    sortKey="pageviews"
                    sort={sort}
                    onSort={onSort}
                    className="hidden text-right sm:table-cell"
                  />
                )}
                <TableHead>
                  <span className="sr-only">
                    {t("mainPanelTabs.analyticsTab.pagesEdit")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => (
                <PageRow
                  key={row.page.key}
                  row={row}
                  max={max}
                  showPageviews={showPageviews}
                  onEdit={onEdit}
                />
              ))}
            </TableBody>
          </Table>
          <ShowAll
            total={rows.length}
            limit={PAGE_ROWS}
            all={allPages}
            onToggle={() => setAllPages((a) => !a)}
          />
        </Section>
      )}

      {cms.pages === null && (
        <p className="text-xs text-muted-foreground">
          {t("mainPanelTabs.analyticsTab.pagesNoCms")}
        </p>
      )}

      {grouped.other.length > 0 && (
        <Section
          title={t("mainPanelTabs.analyticsTab.pagesOtherTitle")}
          subtitle={t("mainPanelTabs.analyticsTab.pagesOtherSubtitle")}
        >
          <Table variant="flush">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">
                  {t("mainPanelTabs.analyticsTab.pagesColPath")}
                </TableHead>
                <TableHead className="text-right">
                  {t("mainPanelTabs.analyticsTab.pagesColVisitors")}
                </TableHead>
                {showPageviews && (
                  <TableHead className="hidden text-right sm:table-cell">
                    {t("mainPanelTabs.analyticsTab.pagesColPageviews")}
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleOther.map((row) => (
                <TableRow key={row.path}>
                  <TableCell className="w-full max-w-0 pl-4">
                    <span
                      className="block truncate font-mono text-xs text-foreground"
                      title={row.path}
                    >
                      {row.path}
                    </span>
                  </TableCell>
                  <VisitorsCell value={row.visitors} max={otherMax} />
                  {showPageviews && (
                    <TableCell className="hidden w-28 text-right tabular-nums text-muted-foreground sm:table-cell">
                      {fmt(row.pageviews)}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ShowAll
            total={grouped.other.length}
            limit={OTHER_ROWS}
            all={allOther}
            onToggle={() => setAllOther((a) => !a)}
          />
        </Section>
      )}
    </div>
  );
}

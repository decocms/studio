import { useState } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  type ContentEntry,
  type ContentType,
  type ContentTypeTree,
  entryMatches,
  summaryFieldsOf,
  visibleTypes,
} from "./content-types";

/** What the Content tab of a hosted v8 site shows beside its sidebar. */
export type ContentTypesView =
  | { kind: "changes" }
  | { kind: "type"; id: string }
  | { kind: "seo" };

/**
 * One small dot per sidebar group, so a type's family reads at a glance. The
 * theme has no tokens for these hues: they stay mid-tone so they read on
 * both themes (as `GLOBAL_SECTION_ICON_COLOR` does).
 */
const GROUP_DOT = {
  pages: "oklch(0.62 0.17 289)",
  redirects: "oklch(0.64 0.13 245)",
  everywhere: "oklch(0.66 0.09 75)",
  content: "oklch(0.6 0.1 270)",
  settings: "oklch(0.65 0 0)",
  seo: "oklch(0.65 0 0)",
} as const;

type DotColor = keyof typeof GROUP_DOT;

/** A type's name in the UI: Studio's own words for the built-ins. */
export function useTypeLabel(): (
  type: Pick<ContentType, "id" | "title">,
) => string {
  const t = useT();
  return (type) =>
    type.id === "page"
      ? t("siteEditor.contentTypes.pages")
      : type.id === "redirect"
        ? t("siteEditor.contentTypes.redirects")
        : type.id === "cms-settings"
          ? t("siteEditor.contentTypes.settings")
          : type.title;
}

/**
 * The content types of a hosted Blocks v8 site: only the types the site has
 * saved blocks of. The site's own (Pages, Redirects, SEO), then the types
 * with one entry every page shows (Header, Footer, Settings), which open
 * that entry directly, then one flat list of the rest, busiest first.
 */
export function ContentTypesSidebar({
  tree,
  view,
  openTypeId,
  onSelect,
  onOpenEntry,
}: {
  tree: ContentTypeTree;
  view: ContentTypesView;
  /** The type of the entry whose editor is open (a singleton's row). */
  openTypeId?: string | null;
  onSelect: (view: ContentTypesView) => void;
  /** A singleton type's row: its one entry's editor. */
  onOpenEntry: (type: ContentType, entry: ContentEntry) => void;
}) {
  const t = useT();
  const label = useTypeLabel();
  const [query, setQuery] = useState("");
  const [showAllTypes, setShowAllTypes] = useState(false);
  const q = query.trim().toLowerCase();
  // A type is found by its name or by any of its entries.
  const matches = (type: ContentType) =>
    !q ||
    label(type).toLowerCase().includes(q) ||
    type.entries.some((e) => entryMatches(e, q, summaryFieldsOf(type)));
  const isActive = (type: ContentType) =>
    openTypeId
      ? openTypeId === type.id
      : view.kind === "type" && view.id === type.id;

  const row = (type: ContentType, dot: DotColor, singleton = false) => (
    <TypeRow
      key={type.id}
      label={label(type)}
      // Settings is the site's, not a part of its pages.
      dot={type.id === "cms-settings" ? "settings" : dot}
      count={singleton ? undefined : type.entries.length}
      changed={type.changed > 0}
      active={isActive(type)}
      onClick={() => {
        const only = type.entries[0];
        // A deleted one has no editor: its row, with Restore, shows instead.
        if (singleton && only && only.status !== "deleted") {
          onOpenEntry(type, only);
        } else onSelect({ kind: "type", id: type.id });
      }}
    />
  );

  const site = [tree.pages, tree.redirects].filter(
    (type): type is ContentType => !!type && matches(type),
  );
  const everywhere = tree.everywhere.filter(matches);
  const typesFound = tree.types.filter(matches);
  // Searching lists every match; otherwise the busiest few, then "Show all".
  const types = q
    ? { shown: typesFound, hidden: 0 }
    : visibleTypes(typesFound, showAllTypes);
  const showSeo =
    !q || t("siteEditor.contentTypes.seo").toLowerCase().includes(q);

  return (
    <nav
      aria-label={t("sandbox.collectionsSidebar.content")}
      className="w-[232px] shrink-0 border-r flex flex-col min-h-0"
    >
      <div className="px-2.5 pt-3 pb-1 shrink-0">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("siteEditor.contentTypes.searchContent")}
          aria-label={t("siteEditor.contentTypes.searchContent")}
          className="w-full rounded-lg bg-muted/60 px-3 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-4 flex flex-col gap-px">
        {tree.changed.length > 0 && (
          <button
            type="button"
            onClick={() => onSelect({ kind: "changes" })}
            className={cn(
              "mt-1.5 mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium cursor-pointer",
              "bg-warning/10 text-warning hover:bg-warning/15",
              view.kind === "changes" &&
                !openTypeId &&
                "ring-1 ring-warning/40",
            )}
          >
            <span className="size-2 shrink-0 rounded-full bg-warning" />
            <span className="flex-1 truncate">
              {t("siteEditor.contentTypes.changesInDraft")}
            </span>
            <span className="text-xs tabular-nums">{tree.changed.length}</span>
          </button>
        )}

        <GroupLabel label={t("siteEditor.contentTypes.group.site")} />
        {site.map((type) =>
          row(type, type.id === tree.pages?.id ? "pages" : "redirects"),
        )}
        {showSeo && (
          <TypeRow
            label={t("siteEditor.contentTypes.seo")}
            dot="seo"
            active={view.kind === "seo" && !openTypeId}
            onClick={() => onSelect({ kind: "seo" })}
          />
        )}

        {everywhere.length > 0 && (
          <>
            <GroupLabel label={t("siteEditor.contentTypes.group.everywhere")} />
            {everywhere.map((type) => row(type, "everywhere", true))}
          </>
        )}

        {types.shown.length > 0 && (
          <>
            <GroupLabel label={t("siteEditor.contentTypes.group.content")} />
            {types.shown.map((type) => row(type, "content"))}
            {!q && (types.hidden > 0 || showAllTypes) && (
              <button
                type="button"
                onClick={() => setShowAllTypes((v) => !v)}
                className="px-2.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {showAllTypes
                  ? t("siteEditor.contentTypes.showFewer")
                  : t("siteEditor.contentTypes.showAll", {
                      count: tree.types.length,
                    })}
              </button>
            )}
          </>
        )}
      </div>
    </nav>
  );
}

function GroupLabel({ label }: { label: string }) {
  return (
    <div className="px-2.5 pt-4 pb-1 text-xs text-muted-foreground/70">
      {label}
    </div>
  );
}

function TypeRow({
  label,
  dot,
  count,
  changed,
  active,
  onClick,
}: {
  label: string;
  dot: DotColor;
  count?: number;
  changed?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground/80 hover:bg-accent hover:text-foreground",
      )}
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: GROUP_DOT[dot] }}
      />
      <span className="flex-1 truncate">{label}</span>
      {changed && (
        <span
          title={t("siteEditor.contentTypes.status.changed")}
          className="size-1.5 shrink-0 rounded-full bg-warning"
        />
      )}
      {count !== undefined && (
        <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground/70">
          {count}
        </span>
      )}
    </button>
  );
}

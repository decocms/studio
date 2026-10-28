import {
  ChevronDown,
  ChevronUp,
  CornerUpRight,
  CreditCardSearch,
  Edit05,
  File04,
  Folder,
  LayoutAlt01,
} from "@untitledui/icons";
import { useState } from "react";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { useT } from "@/i18n/use-t.ts";
import { CollectionGroupLabel, CollectionRow } from "./collection-row";
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
        : type.title;
}

/**
 * The content types of a hosted Blocks v8 site: only the types the site has
 * saved blocks of, as a generic CMS lists them. Collections: Pages and
 * Redirects, then every type with several entries, busiest first, the top
 * few until "Show all". Singletons: SEO, then every type with one entry
 * (Header, Footer), which opens that entry directly. The CMS settings are
 * never listed: they're configuration, not content.
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
  const activeTypeId = openTypeId || (view.kind === "type" ? view.id : null);
  const isActive = (type: ContentType) => activeTypeId === type.id;

  const row = (type: ContentType, singleton = false) => (
    <CollectionRow
      key={type.id}
      icon={singleton ? File04 : iconOf(type)}
      label={label(type)}
      count={singleton ? undefined : type.entries.length}
      mark={type.changed > 0 && <ChangedDot />}
      active={isActive(type)}
      aria-current={isActive(type) ? "page" : undefined}
      onClick={() => {
        const only = type.entries[0];
        // A deleted one has no editor: its row, with Restore, shows instead.
        if (singleton && only && only.status !== "deleted") {
          onOpenEntry(type, only);
        } else onSelect({ kind: "type", id: type.id });
      }}
    />
  );

  const collectionsFound = tree.collections.filter(matches);
  // Searching lists every match; otherwise the busiest few, then "Show all".
  const collections = q
    ? { shown: collectionsFound, hidden: 0 }
    : visibleTypes(collectionsFound, showAllTypes, activeTypeId);
  const singletons = tree.singletons.filter(matches);
  const showSeo =
    !q || t("siteEditor.contentTypes.seo").toLowerCase().includes(q);
  const iconOf = (type: ContentType) =>
    type.id === tree.pages?.id
      ? LayoutAlt01
      : type.id === tree.redirects?.id
        ? CornerUpRight
        : Folder;
  const changesActive = view.kind === "changes" && !openTypeId;
  const seoActive = view.kind === "seo" && !openTypeId;

  return (
    <nav
      aria-label={t("sandbox.collectionsSidebar.content")}
      className="w-[208px] shrink-0 border-r flex flex-col min-h-0"
    >
      <div className="px-1.5 h-12 flex items-center border-b shrink-0">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t("siteEditor.contentTypes.searchContent")}
          className="w-full"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col p-1.5 gap-0.5">
        {tree.changed.length > 0 && (
          <CollectionRow
            icon={Edit05}
            label={t("siteEditor.contentTypes.changesInDraft")}
            count={tree.changed.length}
            mark={<ChangedDot />}
            active={changesActive}
            aria-current={changesActive ? "page" : undefined}
            onClick={() => onSelect({ kind: "changes" })}
          />
        )}

        {collections.shown.length > 0 && (
          <>
            <CollectionGroupLabel
              label={t("siteEditor.contentTypes.group.collections")}
            />
            {collections.shown.map((type) => row(type))}
            {!q && (collections.hidden > 0 || showAllTypes) && (
              <CollectionRow
                icon={showAllTypes ? ChevronUp : ChevronDown}
                label={
                  showAllTypes
                    ? t("siteEditor.contentTypes.showFewer")
                    : t("siteEditor.contentTypes.showAll", {
                        count: tree.collections.length,
                      })
                }
                active={false}
                onClick={() => setShowAllTypes((v) => !v)}
              />
            )}
          </>
        )}

        {(showSeo || singletons.length > 0) && (
          <>
            <CollectionGroupLabel
              label={t("siteEditor.contentTypes.group.singletons")}
            />
            {showSeo && (
              <CollectionRow
                icon={CreditCardSearch}
                label={t("siteEditor.contentTypes.seo")}
                active={seoActive}
                aria-current={seoActive ? "page" : undefined}
                onClick={() => onSelect({ kind: "seo" })}
              />
            )}
            {singletons.map((type) => row(type, true))}
          </>
        )}
      </div>
    </nav>
  );
}

/** "Has changes in the draft", as Studio's sidebar marks a project waiting. */
function ChangedDot() {
  const t = useT();
  return (
    <span
      title={t("siteEditor.contentTypes.status.changed")}
      className="size-2 shrink-0 rounded-full bg-warning"
    />
  );
}

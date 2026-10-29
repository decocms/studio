import {
  BookOpen01,
  Bookmark,
  Calendar,
  CalendarDate,
  ChevronDown,
  CornerUpRight,
  Database01,
  File02,
  Globe01,
  Grid01,
  LayoutAlt01,
  Settings01,
  Sliders02,
  Stars02,
  CreditCardSearch,
  Tag01,
  Users01,
  Zap,
} from "@untitledui/icons";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { CollectionGroupLabel, CollectionRow } from "./collection-row";
import type { CollectionCounts, CollectionId } from "./content-browser";

const ADVANCED_IDS = ["sections", "apps", "loaders", "actions"] as const;
const NONE_HIDDEN: readonly CollectionId[] = [];

export function CollectionsSidebar({
  active,
  counts,
  hidden = NONE_HIDDEN,
  showBlog,
  showContext,
  onSelect,
}: {
  active: CollectionId;
  counts: CollectionCounts;
  /** Collections this site has no use for, left out of the list. */
  hidden?: readonly CollectionId[];
  showBlog: boolean;
  /** The brand context tab, which the org's AI-blog flag governs. */
  showContext: boolean;
  onSelect: (id: CollectionId) => void;
}) {
  const t = useT();
  const shown = (id: CollectionId) => !hidden.includes(id);
  return (
    <div className="w-[208px] shrink-0 border-r flex flex-col">
      <div className="px-3 h-12 flex items-center border-b shrink-0">
        <span className="text-sm font-medium">
          {t("sandbox.collectionsSidebar.content")}
        </span>
      </div>
      <nav className="flex flex-col p-1.5 gap-0.5">
        <CollectionRow
          icon={LayoutAlt01}
          label={t("sandbox.collectionsSidebar.pages")}
          count={counts.pages}
          active={active === "pages"}
          onClick={() => onSelect("pages")}
        />
        <CollectionRow
          icon={CornerUpRight}
          label={t("sandbox.collectionsSidebar.redirects")}
          count={counts.redirects}
          active={active === "redirects"}
          onClick={() => onSelect("redirects")}
        />
        <CollectionRow
          icon={Bookmark}
          label={t("sandbox.collectionsSidebar.savedBlocks")}
          count={counts.savedBlocks}
          active={active === "saved-blocks"}
          onClick={() => onSelect("saved-blocks")}
        />
        {shown("site") && (
          <CollectionRow
            icon={Settings01}
            label={t("sandbox.collectionsSidebar.site")}
            active={active === "site"}
            onClick={() => onSelect("site")}
          />
        )}
        <CollectionRow
          icon={CreditCardSearch}
          label={t("sandbox.collectionsSidebar.seo")}
          active={active === "seo"}
          onClick={() => onSelect("seo")}
        />
        {shown("settings") && (
          <CollectionRow
            icon={Settings01}
            label={t("sandbox.collectionsSidebar.settings")}
            active={active === "settings"}
            onClick={() => onSelect("settings")}
          />
        )}
        {shown("calendar") && (
          <CollectionRow
            icon={Calendar}
            label={t("sandbox.collectionsSidebar.calendar")}
            active={active === "calendar"}
            onClick={() => onSelect("calendar")}
          />
        )}
        <AdvancedGroup
          active={active}
          counts={counts}
          shown={shown}
          onSelect={onSelect}
        />
        {showBlog && (
          <>
            <CollectionGroupLabel
              icon={BookOpen01}
              label={t("sandbox.collectionsSidebar.blog")}
            />
            {showContext && (
              <CollectionRow
                icon={Stars02}
                label={t("sandbox.collectionsSidebar.context")}
                active={active === "context"}
                onClick={() => onSelect("context")}
              />
            )}
            <CollectionRow
              icon={File02}
              label={t("sandbox.collectionsSidebar.posts")}
              count={counts.posts}
              active={active === "posts"}
              onClick={() => onSelect("posts")}
            />
            <CollectionRow
              icon={Users01}
              label={t("sandbox.collectionsSidebar.authors")}
              count={counts.authors}
              active={active === "authors"}
              onClick={() => onSelect("authors")}
            />
            <CollectionRow
              icon={Tag01}
              label={t("sandbox.collectionsSidebar.categories")}
              count={counts.categories}
              active={active === "categories"}
              onClick={() => onSelect("categories")}
            />
            <CollectionRow
              icon={CalendarDate}
              label={t("sandbox.collectionsSidebar.postSchedule")}
              active={active === "post-schedule"}
              onClick={() => onSelect("post-schedule")}
            />
          </>
        )}
      </nav>
    </div>
  );
}

function AdvancedGroup({
  active,
  counts,
  shown,
  onSelect,
}: {
  active: CollectionId;
  counts: CollectionCounts;
  shown: (id: CollectionId) => boolean;
  onSelect: (id: CollectionId) => void;
}) {
  const t = useT();
  const activeIsAdvanced = (ADVANCED_IDS as readonly string[]).includes(active);
  const [userOpen, setUserOpen] = useState(false);
  // Stay open while an item inside is active, so the active row is never hidden.
  const open = userOpen || activeIsAdvanced;
  return (
    <Collapsible open={open} onOpenChange={setUserOpen}>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors cursor-pointer",
          "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Sliders02 size={16} className="shrink-0" />
        <span className="flex-1 truncate">
          {t("sandbox.collectionsSidebar.advanced")}
        </span>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5 pt-0.5">
        <CollectionRow
          icon={Globe01}
          label={t("sandbox.collectionsSidebar.sections")}
          count={counts.sections}
          active={active === "sections"}
          onClick={() => onSelect("sections")}
          indent
        />
        {shown("apps") && (
          <CollectionRow
            icon={Grid01}
            label={t("sandbox.collectionsSidebar.apps")}
            count={counts.apps}
            active={active === "apps"}
            onClick={() => onSelect("apps")}
            indent
          />
        )}
        <CollectionRow
          icon={Database01}
          label={t("sandbox.collectionsSidebar.loaders")}
          count={counts.loaders}
          active={active === "loaders"}
          onClick={() => onSelect("loaders")}
          indent
        />
        {shown("actions") && (
          <CollectionRow
            icon={Zap}
            label={t("sandbox.collectionsSidebar.actions")}
            count={counts.actions}
            active={active === "actions"}
            onClick={() => onSelect("actions")}
            indent
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

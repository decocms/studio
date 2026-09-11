import {
  BookOpen01,
  Calendar,
  CalendarDate,
  ChevronDown,
  CornerUpRight,
  Database01,
  File02,
  Globe02,
  Grid01,
  LayoutAlt01,
  Settings01,
  Sliders02,
  Tag01,
  CreditCardSearch,
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
import type { CollectionCounts, CollectionId } from "./content-browser";

const ADVANCED_IDS = ["sections", "apps", "loaders", "actions"] as const;

export function CollectionsSidebar({
  active,
  counts,
  showBlog,
  onSelect,
}: {
  active: CollectionId;
  counts: CollectionCounts;
  showBlog: boolean;
  onSelect: (id: CollectionId) => void;
}) {
  const t = useT();
  return (
    <div className="w-[208px] shrink-0 border-r flex flex-col">
      <div className="px-3 h-12 flex items-center border-b shrink-0">
        <span className="text-sm font-medium">
          {t("sandbox.collectionsSidebar.content")}
        </span>
      </div>
      <nav className="flex flex-col p-1.5 gap-0.5">
        <CollectionRow
          id="pages"
          icon={LayoutAlt01}
          label={t("sandbox.collectionsSidebar.pages")}
          count={counts.pages}
          active={active === "pages"}
          onSelect={onSelect}
        />
        <CollectionRow
          id="redirects"
          icon={CornerUpRight}
          label={t("sandbox.collectionsSidebar.redirects")}
          count={counts.redirects}
          active={active === "redirects"}
          onSelect={onSelect}
        />
        <CollectionRow
          id="site"
          icon={Settings01}
          label={t("sandbox.collectionsSidebar.site")}
          active={active === "site"}
          onSelect={onSelect}
        />
        <CollectionRow
          id="seo"
          icon={CreditCardSearch}
          label={t("sandbox.collectionsSidebar.seo")}
          active={active === "seo"}
          onSelect={onSelect}
        />
        <CollectionRow
          id="calendar"
          icon={Calendar}
          label={t("sandbox.collectionsSidebar.calendar")}
          active={active === "calendar"}
          onSelect={onSelect}
        />
        <AdvancedGroup active={active} counts={counts} onSelect={onSelect} />
        {showBlog && (
          <>
            <div className="mt-3 flex items-center gap-1.5 px-2.5 pb-1 pt-1 text-xs font-medium text-muted-foreground/70">
              <BookOpen01 size={13} className="shrink-0" />
              {t("sandbox.collectionsSidebar.blog")}
            </div>
            <CollectionRow
              id="posts"
              icon={File02}
              label={t("sandbox.collectionsSidebar.posts")}
              count={counts.posts}
              active={active === "posts"}
              onSelect={onSelect}
            />
            <CollectionRow
              id="authors"
              icon={Users01}
              label={t("sandbox.collectionsSidebar.authors")}
              count={counts.authors}
              active={active === "authors"}
              onSelect={onSelect}
            />
            <CollectionRow
              id="categories"
              icon={Tag01}
              label={t("sandbox.collectionsSidebar.categories")}
              count={counts.categories}
              active={active === "categories"}
              onSelect={onSelect}
            />
            <CollectionRow
              id="post-schedule"
              icon={CalendarDate}
              label={t("sandbox.collectionsSidebar.postSchedule")}
              active={active === "post-schedule"}
              onSelect={onSelect}
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
  onSelect,
}: {
  active: CollectionId;
  counts: CollectionCounts;
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
          "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors cursor-pointer",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
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
          id="sections"
          icon={Globe02}
          label={t("sandbox.collectionsSidebar.sections")}
          count={counts.sections}
          active={active === "sections"}
          onSelect={onSelect}
          indent
        />
        <CollectionRow
          id="apps"
          icon={Grid01}
          label={t("sandbox.collectionsSidebar.apps")}
          count={counts.apps}
          active={active === "apps"}
          onSelect={onSelect}
          indent
        />
        <CollectionRow
          id="loaders"
          icon={Database01}
          label={t("sandbox.collectionsSidebar.loaders")}
          count={counts.loaders}
          active={active === "loaders"}
          onSelect={onSelect}
          indent
        />
        <CollectionRow
          id="actions"
          icon={Zap}
          label={t("sandbox.collectionsSidebar.actions")}
          count={counts.actions}
          active={active === "actions"}
          onSelect={onSelect}
          indent
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function CollectionRow({
  id,
  icon: Icon,
  label,
  count,
  active,
  onSelect,
  indent,
}: {
  id: CollectionId;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  count?: number;
  active: boolean;
  onSelect: (id: CollectionId) => void;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors cursor-pointer",
        indent && "pl-6",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            active ? "text-accent-foreground/70" : "text-muted-foreground/70",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

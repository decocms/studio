import {
  CalendarDate,
  File02,
  Stars02,
  Tag01,
  Users01,
} from "@untitledui/icons";
import { CollectionRow } from "../collection-row";
import { useT } from "@/i18n/use-t.ts";
import type { BlogCollectionId } from "./blog-search-params";

export interface BlogCollectionCounts {
  posts: number;
  authors: number;
  categories: number;
}

export function BlogSidebar({
  active,
  counts,
  showContext,
  onSelect,
}: {
  active: BlogCollectionId;
  counts: BlogCollectionCounts;
  /** The brand context tab, which the org's AI-blog flag governs. */
  showContext: boolean;
  onSelect: (id: BlogCollectionId) => void;
}) {
  const t = useT();
  return (
    <div className="flex w-[208px] shrink-0 flex-col border-r">
      <div className="flex h-12 shrink-0 items-center border-b px-3">
        <span className="text-sm font-medium">
          {t("sandbox.collectionsSidebar.blog")}
        </span>
      </div>
      <nav className="flex flex-col gap-0.5 p-1.5">
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
      </nav>
    </div>
  );
}

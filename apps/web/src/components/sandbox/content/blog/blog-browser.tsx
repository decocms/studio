import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { File02, Plus, SearchLg, Tag01, Users01 } from "@untitledui/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button, buttonVariants } from "@decocms/ui/components/button.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useBlogAi } from "@/hooks/use-blog-ai";
import {
  keptTheirVersion,
  useSaveBlock,
} from "@/components/sections-editor/use-save-block";
import { useDeleteBlock } from "@/components/sections-editor/use-delete-block";
import { useNeverPublished } from "@/components/sections-editor/use-never-published";
import { useShownWhileClosing } from "../closing-dialog";
import { deleteConfirmKey } from "../delete-copy";
import { ItemActions } from "../item-actions";
import { ItemRow } from "../item-row";
import { ListEmpty } from "../list-empty";
import { EmptyMessage } from "../empty-message";
import {
  type BlogEntry,
  type BlogKind,
  BLOG_SINGULAR,
  buildBlogBlock,
  buildPostBlock,
  emptyBlogPayload,
  generateBlogKey,
  getBlogPayload,
  listAllPostPayloads,
  missingFieldsLabel,
  removeCategoryFromPost,
  scanBlogEntries,
  stampPostModified,
  uniqueCategorySlug,
} from "./blog-data";
import { categoryAncestors, orderCategoryTree } from "./category-tree";
import { rescheduleToDay, scheduledPostPayload } from "./post-calendar-data";
import { usePostStatusMove } from "./use-post-status-move";
import { PostsWorkspace, type PostsView } from "./posts-workspace";
import { BlogSidebar } from "./blog-sidebar";
import {
  visibleBlogCollection,
  type BlogCollectionId,
} from "./blog-search-params";
import type { BlogWorkspaceContext } from "./blog-workspace";

const PostCalendar = lazy(() =>
  import("./post-calendar").then((m) => ({ default: m.PostCalendar })),
);

const RecordEditor = lazy(() =>
  import("./record-editor").then((m) => ({ default: m.RecordEditor })),
);

const CategoryEditor = lazy(() =>
  import("./category-editor").then((m) => ({ default: m.CategoryEditor })),
);

const BlogContext = lazy(() =>
  import("./context").then((m) => ({ default: m.BlogContext })),
);

/** The collections that are a list of records beside an editor. A plain
 *  comparison, so TypeScript narrows it without a hand-written predicate. */
function isRecordCollection(
  id: BlogCollectionId,
): id is "authors" | "categories" {
  return id === "authors" || id === "categories";
}

/**
 * The Blog view: its collections on the left, the selected one on the right.
 *
 * Posts are the exception — opening one LEAVES for `/blog/posts/<id>`, where
 * the editor sits beside the site's render of it. Everything else edits in
 * place, as it did inside the Site Editor's Content view.
 */
export function BlogBrowser({
  context,
  collection: requestedCollection,
  item,
  onOpenCollection,
  onSelectItem,
  onOpenPost,
}: {
  context: BlogWorkspaceContext;
  /** From `?blogCollection=`, so it may name a tab the org has turned off. */
  collection: BlogCollectionId;
  /** Decofile block key of the selected author/category, if any. */
  item: string | undefined;
  /** Switch collection AND clear the selection, in ONE navigation: two
   *  back-to-back `navigate` calls in a tick can each read the pre-call search,
   *  and the later one would drop the collection change. */
  onOpenCollection: (next: BlogCollectionId) => void;
  onSelectItem: (key: string | undefined) => void;
  onOpenPost: (blockKey: string) => void;
}) {
  const t = useT();
  const {
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
    sitePreviewUrl,
    hostedDraft,
  } = context;
  const blogAi = useBlogAi();
  const collection = visibleBlogCollection(requestedCollection, blogAi);
  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const deleteBlock = useDeleteBlock({ orgSlug, virtualMcpId, branch });
  // A block the draft created: deleting it is no change Publish lists.
  const neverPublished = useNeverPublished({ orgSlug, virtualMcpId, branch });

  const [searchQuery, setSearchQuery] = useState("");
  const [postsView, setPostsView] = useState<PostsView>("list");
  const [deleteTarget, setDeleteTarget] = useState<BlogEntry | null>(null);
  const deleteTitle = t("sandbox.contentBrowser.deleteDialog.title", {
    noun: deleteTarget ? BLOG_SINGULAR[deleteTarget.kind] : "item",
  });
  const deleteDescription = deleteTarget
    ? t(
        deleteConfirmKey("block", hostedDraft, {
          neverPublished: neverPublished(deleteTarget.key),
        }),
        { label: deleteTarget.label },
      )
    : null;
  // Hosted v8: the dialog keeps its words through its fade (never "Delete
  // item?"); elsewhere exactly as before.
  const deleteWords = useShownWhileClosing(
    deleteDescription === null
      ? null
      : { title: deleteTitle, description: deleteDescription },
    hostedDraft,
  );

  // Reset search when switching collections (derived-state sync pattern).
  const [prevCollection, setPrevCollection] = useState(collection);
  if (prevCollection !== collection) {
    setPrevCollection(collection);
    setSearchQuery("");
  }

  const postMove = usePostStatusMove({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
  });

  const entries = scanBlogEntries(decofile);
  const counts = {
    posts: entries.posts.length,
    authors: entries.authors.length,
    categories: entries.categories.length,
  };

  const createRecord = async (kind: BlogKind) => {
    const key = generateBlogKey(decofile, kind);
    const data = buildBlogBlock(key, kind, emptyBlogPayload(kind));
    try {
      const created = await saveBlock.mutateAsync({ blockKey: key, data });
      if (!keptTheirVersion(created)) {
        toast.success(`Created ${BLOG_SINGULAR[kind]}`);
      }
      onSelectItem(key);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create");
    }
  };

  const duplicateRecord = async (entry: BlogEntry) => {
    const source = decofile[entry.key] as Record<string, unknown> | undefined;
    if (!source) {
      toast.error("Record not found.");
      return;
    }
    const key = generateBlogKey(decofile, entry.kind);
    const labelKey = entry.kind === "posts" ? "title" : "name";
    const payload: Record<string, unknown> = {
      ...structuredClone(getBlogPayload(source, entry.kind)),
      [labelKey]: `${entry.label} (copy)`,
    };
    // A clone keeping the slug would answer for the original.
    if (entry.kind === "categories") {
      const taken = entries.categories.map((c) => c.slug ?? "").filter(Boolean);
      payload.slug = uniqueCategorySlug(String(payload.slug ?? ""), taken);
    }
    try {
      const duplicated = await saveBlock.mutateAsync({
        blockKey: key,
        data: buildBlogBlock(key, entry.kind, payload),
      });
      if (!keptTheirVersion(duplicated)) {
        toast.success(`Duplicated "${entry.label}"`);
      }
      onSelectItem(key);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Duplicate failed");
    }
  };

  /** Calendar "+" on a day: a post scheduled for that day, opened to edit. */
  const createScheduledPost = async (day: Date) => {
    const key = generateBlogKey(decofile, "posts");
    const data = buildBlogBlock(key, "posts", scheduledPostPayload(day));
    try {
      const created = await saveBlock.mutateAsync({ blockKey: key, data });
      if (!keptTheirVersion(created)) {
        toast.success(t("sandbox.postCalendar.createdScheduledPost"));
      }
      onOpenPost(key);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.postCalendar.couldNotCreate"),
      );
    }
  };

  /** Calendar drag: move an already-scheduled post to another day. */
  const reschedulePost = async (key: string, day: Date) => {
    const source = decofile[key] as Record<string, unknown> | undefined;
    const payload = source
      ? rescheduleToDay(getBlogPayload(source, "posts"), day)
      : null;
    if (!payload) {
      toast.error(t("sandbox.postCalendar.onlyScheduledCanMove"));
      return;
    }
    try {
      await saveBlock.mutateAsync({
        blockKey: key,
        data: buildBlogBlock(key, "posts", payload),
      });
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.postCalendar.couldNotReschedule"),
      );
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { kind, key, label } = deleteTarget;
    try {
      // Posts denormalize the slug; unlink first so a failure stays recoverable.
      if (kind === "categories") {
        const slugValue = getBlogPayload(
          decofile[key] as Record<string, unknown> | undefined,
          "categories",
        ).slug;
        const slug = typeof slugValue === "string" ? slugValue : "";
        if (slug) {
          // Both forms: writing a draft back as a live block would publish it.
          for (const { key: postKey, payload } of listAllPostPayloads(
            decofile,
          )) {
            const next = removeCategoryFromPost(payload, slug);
            if (next === payload) continue;
            await saveBlock.mutateAsync({
              blockKey: postKey,
              data: buildPostBlock(postKey, stampPostModified(next)),
            });
          }
        }
      }
      const deleted = await deleteBlock.mutateAsync({ blockKey: key });
      setDeleteTarget(null);
      // The user kept their version (the hook said so in its own toast).
      if (keptTheirVersion(deleted)) return;
      toast.success(`Deleted "${label}"`);
      if (item === key) onSelectItem(undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  // `saveBlock` too: a category delete rewrites its posts before unlinking it.
  const isDeleting = deleteBlock.isPending || saveBlock.isPending;

  return (
    <div className="flex h-full w-full">
      <BlogSidebar
        active={collection}
        counts={counts}
        showContext={blogAi}
        onSelect={onOpenCollection}
      />
      {isRecordCollection(collection) && (
        <RecordList
          kind={collection}
          entries={entries[collection]}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedKey={item}
          onSelect={(key) => onSelectItem(key)}
          onCreate={() => void createRecord(collection)}
          onDuplicate={(entry) => void duplicateRecord(entry)}
          onDelete={setDeleteTarget}
        />
      )}
      <div className="min-w-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          }
        >
          {collection === "context" ? (
            <BlogContext
              orgSlug={orgSlug}
              virtualMcpId={virtualMcpId}
              branch={branch}
              decofile={decofile}
              meta={meta}
            />
          ) : collection === "post-schedule" ? (
            <PostCalendar
              decofile={decofile}
              isCreating={saveBlock.isPending}
              onCreate={(day) => void createScheduledPost(day)}
              onReschedule={(key, day) => void reschedulePost(key, day)}
              onSelect={onOpenPost}
            />
          ) : collection === "posts" ? (
            <PostsWorkspace
              orgSlug={orgSlug}
              virtualMcpId={virtualMcpId}
              branch={branch}
              decofile={decofile}
              view={postsView}
              onViewChange={setPostsView}
              onOpen={onOpenPost}
              move={postMove}
              meta={meta}
            />
          ) : !item ? (
            <EmptyMessage
              title={`Select ${
                collection === "authors" ? "an author" : "a category"
              } to edit`}
              description={
                'Pick an item from the list, or click "+" to create one.'
              }
            />
          ) : collection === "categories" ? (
            <CategoryEditor
              key={`category:${item}`}
              orgSlug={orgSlug}
              virtualMcpId={virtualMcpId}
              branch={branch}
              blockKey={item}
              block={decofile[item] as Record<string, unknown>}
              decofile={decofile}
              meta={meta}
              onManagePosts={() => onOpenCollection("posts")}
              onOpenPost={onOpenPost}
              previewBaseUrl={sitePreviewUrl}
              fastPreviewActive={context.fastPreviewActive}
            />
          ) : (
            <RecordEditor
              key={`authors:${item}`}
              orgSlug={orgSlug}
              virtualMcpId={virtualMcpId}
              branch={branch}
              kind="authors"
              blockKey={item}
              block={decofile[item] as Record<string, unknown>}
              meta={meta}
              decofile={decofile}
            />
          )}
        </Suspense>
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next && !isDeleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteWords?.title ?? deleteTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteWords?.description ?? null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("sandbox.contentBrowser.deleteDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={isDeleting}
              className={cn(buttonVariants({ variant: "destructive" }))}
            >
              {isDeleting ? (
                <>
                  <Spinner className="size-3.5" />
                  {t("sandbox.contentBrowser.deleteDialog.deleting")}
                </>
              ) : (
                t("sandbox.contentBrowser.deleteDialog.delete")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RecordList({
  kind,
  entries,
  searchQuery,
  onSearchChange,
  selectedKey,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
}: {
  kind: Extract<BlogKind, "authors" | "categories">;
  entries: BlogEntry[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedKey: string | undefined;
  onSelect: (key: string) => void;
  onCreate: () => void;
  onDuplicate: (entry: BlogEntry) => void;
  onDelete: (entry: BlogEntry) => void;
}) {
  const t = useT();
  const q = searchQuery.toLowerCase();
  const filtered = entries.filter(
    (e) =>
      !q ||
      e.label.toLowerCase().includes(q) ||
      e.subtitle.toLowerCase().includes(q),
  );
  // Flat while searching: a match under a filtered-out parent would hide.
  const rows =
    kind === "categories" && !q
      ? orderCategoryTree(filtered)
      : filtered.map((entry) => ({ entry, depth: 0 }));

  const placeholder = `Search ${kind}…`;
  const createTooltip = `Create new ${BLOG_SINGULAR[kind]}`;

  return (
    <div className="flex w-[300px] min-h-0 shrink-0 flex-col border-r">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <div className="flex flex-1 items-center gap-2 pl-1">
          <SearchLg
            size={14}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onCreate}
              aria-label={createTooltip}
            >
              <Plus size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{createTooltip}</TooltipContent>
        </Tooltip>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1">
          {filtered.length === 0 ? (
            <ListEmpty
              hasItems={entries.length > 0}
              emptyLabel={`No ${kind} yet.`}
              emptyHint={`Click "+" to create your first ${BLOG_SINGULAR[kind]}.`}
            />
          ) : (
            rows.map(({ entry, depth }) => (
              <div key={entry.key} style={{ paddingLeft: depth * 16 }}>
                <ItemRow
                  icon={
                    entry.kind === "posts"
                      ? File02
                      : entry.kind === "authors"
                        ? Users01
                        : Tag01
                  }
                  title={entry.label}
                  invalid={entry.missing.length > 0}
                  invalidReason={
                    entry.missing.length > 0
                      ? t("sandbox.itemRow.missingFields", {
                          fields: missingFieldsLabel(entry.missing, t),
                        })
                      : undefined
                  }
                  warning={entry.duplicateName}
                  warningReason={t("sandbox.itemRow.duplicateName")}
                  subtitle={
                    depth > 0
                      ? categoryAncestors(entry.slug ?? "", filtered)
                          .map((c) => c.slug)
                          .join(" / ")
                      : entry.subtitle
                  }
                  active={selectedKey === entry.key}
                  onClick={() => onSelect(entry.key)}
                  menu={
                    <ItemActions
                      onDuplicate={() => onDuplicate(entry)}
                      onDelete={() => onDelete(entry)}
                    />
                  }
                />
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

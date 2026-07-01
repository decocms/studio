import { useState } from "react";
import { ArrowRight, File02, Loading01 } from "@untitledui/icons";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { type LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import {
  buildBlogBlock,
  getBlogPayload,
  listBlogPayloads,
  listPostsWithMeta,
  renameCategoryOnPost,
} from "./blog-data";
import { useSaveBlogBlock } from "./use-blog-mutations";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { BlogSandboxProvider } from "./blog-sandbox-context";
import { asBlocks, BlockDocument } from "./block-document";
import { InlineText, str } from "./blocks/primitives";

/**
 * Notion-style category editor: large inline name + slug input + inline
 * description + the same block document used by posts. Mirrors PostEditor's
 * layout so authors edit categories with the same affordances.
 *
 * Slug renames cascade to posts. Posts reference a category by a denormalized
 * `{ name, slug }` copy (categories aren't strongly typed on posts), so a
 * rename must rewrite every post that carried the old slug — otherwise those
 * posts silently point at a slug that no longer resolves. The cascade is a
 * deliberate, committed action (fires on blur behind a confirm dialog), NOT on
 * every keystroke: it matches posts against the last *persisted* slug, so a
 * half-typed slug never leaks into posts and the match key never drifts.
 */
export function CategoryEditor({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  block,
  decofile,
  meta,
  onManagePosts,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  onManagePosts: (slug: string) => void;
}) {
  const save = useSaveBlogBlock({ orgSlug, virtualMcpId, branch });
  const initial = getBlogPayload(block, "categories");

  const [category, setCategory, syncCategory] = useAutosave(initial, (next) => {
    save.mutate({
      blockKey,
      data: buildBlogBlock(blockKey, "categories", next),
    });
  });

  const setField = (key: string, value: unknown) =>
    setCategory({ ...category, [key]: value });

  // The slug input is a free-text draft, committed only on blur — its
  // keystrokes must not autosave (each would churn every post via the
  // cascade and turn a half-typed slug into the match key for the next edit).
  const committedSlug = str(category.slug);
  const [slugDraft, setSlugDraft] = useState(committedSlug);
  const [pendingRename, setPendingRename] = useState<{
    oldSlug: string;
    newSlug: string;
    count: number;
  } | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);

  const postCount = committedSlug
    ? listPostsWithMeta(decofile).filter((p) =>
        p.categorySlugs.includes(committedSlug),
      ).length
    : 0;

  /** Persist the new slug on the category block itself (no cascade). */
  const commitSlug = (newSlug: string) => setField("slug", newSlug);

  /**
   * Rewrite every post that referenced `oldSlug` to the new slug + name, then
   * persist the category. Sequential writes: each mutation's optimistic patch
   * lands on the shared decofile cache key, so parallel writes would lose
   * updates (same reasoning as the bulk-category apply).
   */
  const runRename = async (oldSlug: string, newSlug: string) => {
    const name = str(category.name);
    setIsRenaming(true);
    try {
      let changed = 0;
      for (const { key, payload } of listBlogPayloads(decofile, "posts")) {
        const next = renameCategoryOnPost(payload, oldSlug, {
          name,
          slug: newSlug,
        });
        if (next === payload) continue;
        await save.mutateAsync({
          blockKey: key,
          data: buildBlogBlock(key, "posts", next),
        });
        changed += 1;
      }
      // Persist the category block with its new slug and AWAIT it before
      // reporting success — routing this through the debounced autosave would
      // let the toast fire (and the user navigate away) before the write is
      // even dispatched, leaving posts renamed but the category slug possibly
      // never persisted. `nextCategory` carries the full current draft, so the
      // write captures any name/description edits made before the rename.
      const nextCategory = { ...category, slug: newSlug };
      await save.mutateAsync({
        blockKey,
        data: buildBlogBlock(blockKey, "categories", nextCategory),
      });
      // Draft-only catch-up (no extra write): keeps future name/description
      // edits on the new slug instead of spreading the stale one back in.
      syncCategory(nextCategory);
      toast.success(
        changed > 0
          ? `Renamed slug and updated ${changed} ${changed === 1 ? "post" : "posts"}`
          : "Renamed slug",
      );
      setPendingRename(null);
    } catch (err) {
      // Posts may be half-migrated. Reset the input to the persisted slug so
      // the user can retry the rename cleanly.
      setSlugDraft(oldSlug);
      setPendingRename(null);
      toast.error(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setIsRenaming(false);
    }
  };

  /** Blur handler: decide between a plain slug edit and a cascading rename. */
  const commitSlugFromDraft = () => {
    const newSlug = slugDraft.trim();
    if (newSlug === committedSlug) {
      if (slugDraft !== newSlug) setSlugDraft(newSlug);
      return;
    }
    // An empty slug would orphan every post — refuse and revert.
    if (!newSlug) {
      setSlugDraft(committedSlug);
      return;
    }
    const count = committedSlug
      ? listPostsWithMeta(decofile).filter((p) =>
          p.categorySlugs.includes(committedSlug),
        ).length
      : 0;
    if (count === 0) {
      commitSlug(newSlug);
      return;
    }
    setPendingRename({ oldSlug: committedSlug, newSlug, count });
  };

  return (
    <BlogSandboxProvider
      orgSlug={orgSlug}
      virtualMcpId={virtualMcpId}
      branch={branch}
    >
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
          <span className="truncate text-sm font-medium">
            {str(category.name) || "Untitled category"}
          </span>
          <SaveStatus isPending={save.isPending} isError={save.isError} />
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-8">
            <InlineText
              value={str(category.name)}
              onChange={(v) => setField("name", v)}
              placeholder="Category name"
              className="py-1 text-3xl font-bold text-foreground"
            />

            <div className="mt-4 space-y-2">
              <Label htmlFor="category-slug">Slug</Label>
              <Input
                id="category-slug"
                value={slugDraft}
                onChange={(e) => setSlugDraft(e.target.value)}
                onBlur={commitSlugFromDraft}
                placeholder="my-category"
                className="h-10"
              />
            </div>

            <div className="mt-4 space-y-2">
              <Label htmlFor="category-description">Description</Label>
              <Input
                id="category-description"
                value={str(category.description)}
                onChange={(e) => setField("description", e.target.value)}
                placeholder="Short description for this category"
                className="h-10"
              />
            </div>

            <div className="mt-6 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <File02 size={16} className="shrink-0 text-muted-foreground" />
                <span className="text-sm">
                  {postCount} {postCount === 1 ? "post" : "posts"} in this
                  category
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!committedSlug}
                title={
                  committedSlug
                    ? "Jump to the posts list filtered by this category"
                    : "Set a slug to manage this category's posts"
                }
                onClick={() => onManagePosts(committedSlug)}
              >
                Manage posts
                <ArrowRight size={14} />
              </Button>
            </div>

            <div className="mt-6 border-t" />

            <BlockDocument
              value={asBlocks(category.sections)}
              onChange={(next) => setField("sections", next)}
              meta={meta}
              emptyMessage="This category has no content yet. Use ⊕ to add your first block."
            />
          </div>
        </div>
      </div>

      <AlertDialog
        open={!!pendingRename}
        onOpenChange={(open) => {
          if (open || isRenaming) return;
          // Cancelled: revert the input to the persisted slug.
          setSlugDraft(committedSlug);
          setPendingRename(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename category slug?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRename
                ? `Changing the slug from "${pendingRename.oldSlug}" to "${pendingRename.newSlug}" will update ${pendingRename.count} ${
                    pendingRename.count === 1 ? "post" : "posts"
                  } that reference this category.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRenaming}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (pendingRename) {
                  void runRename(pendingRename.oldSlug, pendingRename.newSlug);
                }
              }}
              disabled={isRenaming}
            >
              {isRenaming ? (
                <>
                  <Loading01 size={14} className="animate-spin" />
                  Renaming…
                </>
              ) : (
                "Rename & update posts"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </BlogSandboxProvider>
  );
}

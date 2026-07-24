import { useState } from "react";
import {
  ArrowRight,
  File02,
  LinkExternal01,
  Loading01,
  Pilcrow01,
} from "@untitledui/icons";
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
import { useT } from "@/i18n/use-t.ts";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  buildBlogBlock,
  getBlogPayload,
  listBlogPayloads,
  listPostsWithMeta,
  renameCategoryOnPost,
  stampPostModified,
} from "./blog-data";
import { buildBlogCategoryPreviewUrl } from "./blog-preview-url";
import { usePackagePath } from "@/components/sections-editor/use-package-path";
import { useSaveBlogBlock } from "./use-blog-mutations";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { asBlocks, BlockDocument } from "./block-document";
import { CollapsibleSection } from "./editor-section";
import { EditableText, str } from "./blocks/primitives";

/**
 * Category editor: an editable name heading, slug / description inputs, the
 * block-document content panel, and the list of posts in this category (plus a
 * "See category preview" action). Mirrors PostEditor's layout so authors edit
 * categories with the same affordances.
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
  onOpenPost,
  previewBaseUrl,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  /**
   * Jump to the posts list with the bulk "Update category" panel open for
   * this category.
   */
  onManagePosts: (slug: string) => void;
  onOpenPost: (key: string) => void;
  previewBaseUrl?: string | null;
}) {
  const t = useT();
  const save = useSaveBlogBlock({
    orgSlug,
    virtualMcpId,
    branch,
    packagePath: usePackagePath(virtualMcpId),
  });
  const initial = getBlogPayload(block, "categories");

  const [category, setCategory, syncCategory] = useAutosave(initial, (next) => {
    save.mutate({
      blockKey,
      data: buildBlogBlock(blockKey, "categories", next),
    });
  });

  const setField = (key: string, value: unknown) =>
    setCategory({ ...category, [key]: value });

  // Only offer a preview when the blog app has a `categorySlug` route
  // template configured — otherwise there is no category page to open.
  const previewUrl = buildBlogCategoryPreviewUrl({
    decofile,
    category,
    previewBaseUrl,
  });

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

  const posts = committedSlug
    ? listPostsWithMeta(decofile).filter((p) =>
        p.categorySlugs.includes(committedSlug),
      )
    : [];
  const postCount = posts.length;

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
          data: buildBlogBlock(key, "posts", stampPostModified(next)),
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
          ? t("sandbox.categoryEditor.renameSuccessWithPosts", {
              count: String(changed),
            })
          : t("sandbox.categoryEditor.renameSuccessNoPosts"),
      );
      setPendingRename(null);
    } catch (err) {
      // Posts may be half-migrated. Reset the input to the persisted slug so
      // the user can retry the rename cleanly.
      setSlugDraft(oldSlug);
      setPendingRename(null);
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.categoryEditor.renameFailed"),
      );
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
    if (postCount === 0) {
      commitSlug(newSlug);
      return;
    }
    setPendingRename({ oldSlug: committedSlug, newSlug, count: postCount });
  };

  return (
    <>
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
          <span className="truncate text-sm font-medium">
            {str(category.name) || t("sandbox.categoryEditor.untitledCategory")}
          </span>
          <div className="flex shrink-0 items-center gap-3">
            <SaveStatus isPending={save.isPending} isError={save.isError} />
            {previewUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                title={t("sandbox.categoryEditor.previewTooltip")}
                onClick={() =>
                  window.open(previewUrl, "_blank", "noopener,noreferrer")
                }
              >
                <LinkExternal01 size={14} />
                {t("sandbox.categoryEditor.seeCategoryPreview")}
              </Button>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl px-8 py-8">
            <EditableText
              value={str(category.name)}
              onChange={(v) => setField("name", v)}
              placeholder={t("sandbox.categoryEditor.categoryNamePlaceholder")}
              className="py-1 text-3xl font-bold text-foreground"
            />

            <div className="mt-4 space-y-2">
              <Label htmlFor="category-slug">
                {t("sandbox.categoryEditor.slugLabel")}
              </Label>
              <Input
                id="category-slug"
                value={slugDraft}
                onChange={(e) => setSlugDraft(e.target.value)}
                onBlur={commitSlugFromDraft}
                placeholder={t("sandbox.categoryEditor.slugPlaceholder")}
                className="h-10"
              />
            </div>

            <div className="mt-4 space-y-2">
              <Label htmlFor="category-description">
                {t("sandbox.categoryEditor.descriptionLabel")}
              </Label>
              <Input
                id="category-description"
                value={str(category.description)}
                onChange={(e) => setField("description", e.target.value)}
                placeholder={t("sandbox.categoryEditor.descriptionPlaceholder")}
                className="h-10"
              />
            </div>

            {/* Category page content — same collapsible panel as the post body */}
            <CollapsibleSection
              icon={Pilcrow01}
              title={t("sandbox.categoryEditor.contentTitle")}
              defaultOpen
            >
              <BlockDocument
                value={asBlocks(category.sections)}
                onChange={(next) => setField("sections", next)}
                meta={meta}
                sandboxRef={{ orgSlug, virtualMcpId, branch }}
                emptyMessage={t("sandbox.categoryEditor.noContentEmpty")}
              />
            </CollapsibleSection>

            {/* Posts in this category */}
            <div className="mt-6 overflow-hidden rounded-lg border bg-muted/30">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <File02
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="text-sm">
                    {t("sandbox.categoryEditor.postsInCategory", {
                      count: String(postCount),
                    })}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!committedSlug}
                  title={
                    !committedSlug
                      ? t("sandbox.categoryEditor.setSlugTooltip")
                      : t("sandbox.categoryEditor.pickPostsTooltip")
                  }
                  onClick={() => onManagePosts(committedSlug)}
                >
                  {t("sandbox.categoryEditor.addPostsButton")}
                  <ArrowRight size={14} />
                </Button>
              </div>
              {postCount > 0 && (
                <ul className="divide-y border-t bg-background">
                  {posts.map((p) => (
                    <li key={p.key}>
                      <button
                        type="button"
                        onClick={() => onOpenPost(p.key)}
                        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-muted cursor-pointer"
                      >
                        <File02
                          size={14}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">
                            {p.title ||
                              t("sandbox.categoryEditor.untitledPost")}
                          </span>
                          {p.slug && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {p.slug}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
            <AlertDialogTitle>
              {t("sandbox.categoryEditor.renameDialogTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRename
                ? t("sandbox.categoryEditor.renameDialogDescription", {
                    oldSlug: pendingRename.oldSlug,
                    newSlug: pendingRename.newSlug,
                    count: String(pendingRename.count),
                  })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRenaming}>
              {t("sandbox.categoryEditor.cancelButton")}
            </AlertDialogCancel>
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
                  {t("sandbox.categoryEditor.renamingLabel")}
                </>
              ) : (
                t("sandbox.categoryEditor.renameActionButton")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

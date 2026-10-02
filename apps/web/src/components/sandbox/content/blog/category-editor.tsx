import { useOptionalChatTask } from "@/components/chat/chat-context";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  File02,
  LinkExternal01,
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
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useT } from "@/i18n/use-t.ts";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  buildBlogBlock,
  type CategoryRef,
  getBlogPayload,
  listBlogPayloads,
  hasDuplicateName,
  listPostsWithMeta,
  maskSlugInput,
  missingCategoryFields,
  renameCategoryOnPost,
  reparentCategory,
  scanBlogEntries,
  slugifyTitle,
  stampPostModified,
  uniqueCategorySlug,
} from "./blog-data";
import {
  descendantSlugs,
  MAX_CATEGORY_DEPTH,
  orderCategoryTree,
} from "./category-tree";
import { buildBlogCategoryPreviewUrl } from "./blog-preview-url";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useDraftPointer } from "@/components/sections-editor/use-fast-preview-draft-url";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { asBlocks, BlockDocument } from "./block-document";
import { CollapsibleSection } from "./editor-section";
import { EditableText, str } from "./blocks/primitives";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";

/** Radix Select rejects "" as an item value, so "no parent" needs a sentinel. */
const NO_PARENT = "__none__";

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
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const draftPointer = useDraftPointer({ orgSlug, virtualMcpId, branch });
  const initial = getBlogPayload(block, "categories");

  const [category, setCategory, syncCategory] = useAutosave(
    initial,
    (next) => {
      save.mutate({
        blockKey,
        data: buildBlogBlock(blockKey, "categories", next),
      });
    },
    { isSaving: save.isPending },
  );

  const setField = (key: string, value: unknown) =>
    setCategory({ ...category, [key]: value });

  // Only offer a preview when the blog app has a `categorySlug` route
  // template configured — otherwise there is no category page to open.
  const previewUrl = buildBlogCategoryPreviewUrl({
    decofile,
    category,
    previewBaseUrl,
    draftPointer,
  });

  // The slug input is a free-text draft, committed only on blur — its
  // keystrokes must not autosave (each would churn every post via the
  // cascade and turn a half-typed slug into the match key for the next edit).
  const committedSlug = str(category.slug);
  const [slugDraft, setSlugDraft] = useState(committedSlug);
  const [slugNotice, setSlugNotice] = useState<string | null>(null);
  // Re-seed when the slug changes under us (another session, or `runRename`).
  const [seenSlug, setSeenSlug] = useState(committedSlug);
  if (seenSlug !== committedSlug) {
    setSeenSlug(committedSlug);
    setSlugDraft(committedSlug);
  }
  const [pendingRename, setPendingRename] = useState<{
    oldSlug: string;
    newSlug: string;
    count: number;
    children: number;
  } | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);

  const posts = committedSlug
    ? listPostsWithMeta(decofile).filter((p) =>
        p.categorySlugs.includes(committedSlug),
      )
    : [];
  const postCount = posts.length;

  const categoryEntries = scanBlogEntries(decofile).categories;
  const children = committedSlug
    ? categoryEntries.filter((c) => c.parentSlug === committedSlug)
    : [];
  const childCount = children.length;

  // Own subtree would close a cycle; a parent at the cap has no room.
  const forbidden = committedSlug
    ? descendantSlugs(committedSlug, categoryEntries).add(committedSlug)
    : new Set<string>();
  const parentOptions = orderCategoryTree(categoryEntries)
    .filter(
      ({ entry, depth }) =>
        entry.slug &&
        !forbidden.has(entry.slug) &&
        depth + 1 < MAX_CATEGORY_DEPTH,
    )
    .map(({ entry, depth }) => ({
      slug: entry.slug as string,
      label: entry.label,
      depth,
    }));
  const parentSlug = str(category.parentSlug);

  // Two categories sharing a name is legal but confusing; warn, never block.
  const duplicateName = hasDuplicateName(
    decofile,
    "categories",
    blockKey,
    str(category.name),
  );

  const missing = missingCategoryFields(category);
  const missingLabel =
    missing.length === 1
      ? t("sandbox.postEditor.missingFieldSingular", {
          fields: missing.join(", "),
        })
      : t("sandbox.postEditor.missingFieldPlural", {
          fields: missing.join(", "),
        });

  /** Persist the new slug on the category block itself (no cascade). */
  const commitSlug = (newSlug: string) => setField("slug", newSlug);

  /**
   * Rewrite every post that references `oldSlug` to carry `ref`, and report
   * how many changed. Sequential: each mutation's optimistic patch lands on
   * the shared decofile cache key, so parallel writes would lose updates.
   * `renameCategoryOnPost` is identity-stable, so a post already carrying
   * `ref` costs no write.
   */
  const cascadeToPosts = async (oldSlug: string, ref: CategoryRef) => {
    let changed = 0;
    for (const { key, payload } of listBlogPayloads(decofile, "posts")) {
      const next = renameCategoryOnPost(payload, oldSlug, ref);
      if (next === payload) continue;
      await save.mutateAsync({
        blockKey: key,
        data: buildBlogBlock(key, "posts", stampPostModified(next)),
      });
      changed += 1;
    }
    return changed;
  };

  /**
   * Posts denormalize the category's name, so an edit to it has to reach them
   * or they keep rendering the old one on the site. On blur, not per
   * keystroke: typing a name would otherwise rewrite every post per character.
   * No confirm dialog, unlike a slug rename — this changes no URL, it only
   * repairs copies that are already meant to agree.
   */
  const commitName = async () => {
    if (!committedSlug || isRenaming) return;
    const name = str(category.name);
    setIsRenaming(true);
    try {
      const changed = await cascadeToPosts(committedSlug, {
        name,
        slug: committedSlug,
      });
      if (changed > 0) {
        toast.success(
          t("sandbox.categoryEditor.renameNameSuccess", {
            count: String(changed),
          }),
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.categoryEditor.renameFailed"),
      );
    } finally {
      setIsRenaming(false);
    }
  };

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
      const changed = await cascadeToPosts(oldSlug, { name, slug: newSlug });
      // Children hold a slug copy too, so the rename has to follow them.
      for (const { key, payload } of listBlogPayloads(decofile, "categories")) {
        const next = reparentCategory(payload, oldSlug, newSlug);
        if (next === payload) continue;
        await save.mutateAsync({
          blockKey: key,
          data: buildBlogBlock(key, "categories", next),
        });
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

  /**
   * Blur handler: normalize the slug, suffix it when another category owns it,
   * then decide between a plain edit and a cascading rename. The cascade must
   * receive the deduped slug — it is the one that gets written everywhere.
   */
  const commitSlugFromDraft = () => {
    const normalized = slugifyTitle(slugDraft);
    setSlugDraft(normalized);
    if (normalized === committedSlug) return;
    // Refuse: unlike a post's, this slug is the cascades' match key.
    if (!normalized) {
      setSlugDraft(committedSlug);
      setSlugNotice(null);
      return;
    }
    const taken = categoryEntries
      .filter((entry) => entry.key !== blockKey)
      .map((entry) => str(entry.slug))
      .filter(Boolean);

    let newSlug = normalized;
    if (taken.includes(normalized)) {
      newSlug = uniqueCategorySlug(normalized, taken);
      const message = t("sandbox.categoryEditor.slugDeduped", {
        slug: newSlug,
      });
      setSlugDraft(newSlug);
      // Inline too: a dismissed toast would hide that the URL changed.
      setSlugNotice(message);
      toast.info(message);
    } else {
      setSlugNotice(null);
    }

    if (postCount === 0 && childCount === 0) {
      commitSlug(newSlug);
      return;
    }
    setPendingRename({
      oldSlug: committedSlug,
      newSlug,
      count: postCount,
      children: childCount,
    });
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
            {missing.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <AlertCircle size={14} />
                    {missing.length}{" "}
                    {missing.length === 1
                      ? t("sandbox.postEditor.issueSingular")
                      : t("sandbox.postEditor.issuePlural")}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{missingLabel}</TooltipContent>
              </Tooltip>
            )}
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
              onBlur={() => void commitName()}
              placeholder={t("sandbox.categoryEditor.categoryNamePlaceholder")}
              className="py-1 text-3xl font-bold text-foreground"
            />
            {duplicateName && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
                <AlertCircle size={14} className="mt-px shrink-0" />
                {t("sandbox.categoryEditor.duplicateNameWarning")}
              </p>
            )}

            <div className="mt-4 space-y-2">
              <Label htmlFor="category-slug">
                {t("sandbox.categoryEditor.slugLabel")}
              </Label>
              <Input
                id="category-slug"
                value={slugDraft}
                onChange={(e) => {
                  setSlugNotice(null);
                  setSlugDraft(maskSlugInput(e.target.value));
                }}
                onBlur={commitSlugFromDraft}
                placeholder={t("sandbox.categoryEditor.slugPlaceholder")}
                maxLength={80}
                className="h-10"
              />
              {slugNotice && (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <AlertCircle size={14} className="mt-px shrink-0" />
                  {slugNotice}
                </p>
              )}
            </div>

            <div className="mt-4 space-y-2">
              <Label htmlFor="category-parent">
                {t("sandbox.categoryEditor.parentLabel")}
              </Label>
              <Select
                value={parentSlug || NO_PARENT}
                onValueChange={(v) =>
                  setField("parentSlug", v === NO_PARENT ? undefined : v)
                }
              >
                <SelectTrigger id="category-parent" className="h-10 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT}>
                    {t("sandbox.categoryEditor.parentNone")}
                  </SelectItem>
                  {parentOptions.map((option) => (
                    <SelectItem key={option.slug} value={option.slug}>
                      <span style={{ paddingLeft: option.depth * 12 }}>
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.categoryEditor.parentDescription")}
              </p>
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
                sandboxRef={{ orgSlug, virtualMcpId, branch, threadId }}
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
              {pendingRename && pendingRename.children > 0
                ? ` ${t("sandbox.categoryEditor.renameDialogChildren", {
                    count: String(pendingRename.children),
                  })}`
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
                  <Spinner className="size-3.5" />
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

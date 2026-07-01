import { ArrowRight, File02, LinkExternal01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { type LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { buildBlogBlock, getBlogPayload, listPostsWithMeta } from "./blog-data";
import { buildBlogCategoryPreviewUrl } from "./blog-preview-url";
import { useSaveBlogBlock } from "./use-blog-mutations";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { BlogSandboxProvider } from "./blog-sandbox-context";
import { asBlocks, BlockDocument } from "./block-document";
import { EditableText, str } from "./blocks/primitives";

/**
 * Notion-style category editor: large inline name + slug input + inline
 * description + the same block document used by posts. Mirrors PostEditor's
 * layout so authors edit categories with the same affordances.
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
  previewBaseUrl,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  onManagePosts: (slug: string) => void;
  previewBaseUrl?: string | null;
}) {
  const save = useSaveBlogBlock({ orgSlug, virtualMcpId, branch });
  const initial = getBlogPayload(block, "categories");

  const [category, setCategory] = useAutosave(initial, (next) => {
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

  const slug = str(category.slug);
  const postCount = slug
    ? listPostsWithMeta(decofile).filter((p) => p.categorySlugs.includes(slug))
        .length
    : 0;

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
          <div className="flex shrink-0 items-center gap-3">
            <SaveStatus isPending={save.isPending} isError={save.isError} />
            {previewUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                title="Open the category preview in a new tab"
                onClick={() =>
                  window.open(previewUrl, "_blank", "noopener,noreferrer")
                }
              >
                <LinkExternal01 size={14} />
                See category preview
              </Button>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-8">
            <EditableText
              value={str(category.name)}
              onChange={(v) => setField("name", v)}
              placeholder="Category name"
              className="py-1 text-3xl font-bold text-foreground"
            />

            <div className="mt-4 space-y-2">
              <Label htmlFor="category-slug">Slug</Label>
              <Input
                id="category-slug"
                value={str(category.slug)}
                onChange={(e) => setField("slug", e.target.value)}
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
                disabled={!slug}
                title={
                  slug
                    ? "Jump to the posts list filtered by this category"
                    : "Set a slug to manage this category's posts"
                }
                onClick={() => onManagePosts(slug)}
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
    </BlogSandboxProvider>
  );
}

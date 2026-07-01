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
import { str } from "./blocks/primitives";

/**
 * Category editor: name / slug / description inputs, the same block document
 * canvas used by posts, and the list of posts in this category. Mirrors
 * PostEditor's layout so authors edit categories with the same affordances.
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
  onManagePosts: (slug: string) => void;
  onOpenPost: (key: string) => void;
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
  const posts = slug
    ? listPostsWithMeta(decofile).filter((p) => p.categorySlugs.includes(slug))
    : [];
  const postCount = posts.length;

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
            <div className="space-y-2">
              <Label htmlFor="category-name">Name</Label>
              <Input
                id="category-name"
                value={str(category.name)}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="Category name"
                className="h-10"
              />
            </div>

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

            {/* Category page content — same canvas as the post body */}
            <div className="mt-6">
              <BlockDocument
                value={asBlocks(category.sections)}
                onChange={(next) => setField("sections", next)}
                meta={meta}
                label="Content"
                emptyMessage="This category has no content yet. Use ⊕ to add your first block."
              />
            </div>

            {/* Posts in this category */}
            <div className="mt-6 overflow-hidden rounded-lg border bg-muted/30">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <File02
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
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
                    !slug
                      ? "Set a slug to manage this category's posts"
                      : postCount === 0
                        ? "Go to the posts list to add posts to this category"
                        : "Jump to the posts list filtered by this category"
                  }
                  onClick={() => onManagePosts(postCount === 0 ? "" : slug)}
                >
                  {postCount === 0 ? "Add posts" : "Manage posts"}
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
                            {p.title || "Untitled post"}
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
    </BlogSandboxProvider>
  );
}

import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { type LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { buildBlogBlock, getBlogPayload } from "./blog-data";
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
 */
export function CategoryEditor({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  block,
  meta,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
  meta: LiveMeta;
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

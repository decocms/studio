import { useState } from "react";
import { ChevronDown, Settings01 } from "@untitledui/icons";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { ImageField } from "@/web/components/sections-editor/fields/image-field";
import { StringField } from "@/web/components/sections-editor/fields/string-field";
import { type LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import {
  buildBlogBlock,
  discoverBlogBlockTypes,
  getBlogPayload,
  listBlogPayloads,
} from "./blog-data";
import { useSaveBlogBlock } from "./use-blog-mutations";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { BlogSandboxProvider } from "./blog-sandbox-context";
import { InsertBlockDivider } from "./block-picker";
import { BlockRow } from "./blocks/block-row";
import { type RawBlock } from "./blocks/block-registry";
import { InlineText, str } from "./blocks/primitives";

type BlockItem = { id: string; block: RawBlock };

function asBlocks(value: unknown): RawBlock[] {
  return Array.isArray(value) ? (value as RawBlock[]) : [];
}

/**
 * Notion-style post editor: a title, a collapsible settings panel, and the
 * post body rendered as a document of inline-editable blocks. Each block
 * renders as its content type (paragraph, heading, list, …); a ⊕ between
 * blocks inserts, and a drag handle reorders. Not a schema form.
 */
export function PostEditor({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  block,
  decofile,
  meta,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
}) {
  const save = useSaveBlogBlock({ orgSlug, virtualMcpId, branch });
  const initial = getBlogPayload(block, "posts");

  const [post, setPost] = useAutosave(initial, (next) => {
    save.mutate({ blockKey, data: buildBlogBlock(blockKey, "posts", next) });
  });

  const blockTypes = discoverBlogBlockTypes(meta);

  // Ids and blocks are co-located in one piece of state so dnd-kit's
  // sortable identity never drifts from the block list. All mutations go
  // through syncBlocks which updates both atomically.
  const [blockItems, setBlockItems] = useState<BlockItem[]>(() =>
    asBlocks(initial.sections).map((blk) => ({ id: uid(), block: blk })),
  );

  const ids = blockItems.map((x) => x.id);
  const blocks = blockItems.map((x) => x.block);

  const syncBlocks = (items: BlockItem[]) => {
    setBlockItems(items);
    setPost({ ...post, sections: items.map((x) => x.block) });
  };

  const setField = (key: string, value: unknown) =>
    setPost({ ...post, [key]: value });

  const insertAt = (index: number, resolveType: string) => {
    const next = [...blockItems];
    next.splice(index, 0, { id: uid(), block: { __resolveType: resolveType } });
    syncBlocks(next);
  };

  const updateAt = (index: number, value: RawBlock) => {
    syncBlocks(
      blockItems.map((item, i) =>
        i === index ? { ...item, block: value } : item,
      ),
    );
  };

  const removeAt = (index: number) => {
    syncBlocks(blockItems.filter((_, i) => i !== index));
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = blockItems.findIndex((x) => x.id === String(active.id));
    const newIndex = blockItems.findIndex((x) => x.id === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    syncBlocks(arrayMove(blockItems, oldIndex, newIndex));
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
            {str(post.title) || "Untitled post"}
          </span>
          <SaveStatus isPending={save.isPending} isError={save.isError} />
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-8">
            {/* Title — wraps onto multiple lines instead of truncating */}
            <InlineText
              value={str(post.title)}
              onChange={(v) => setField("title", v)}
              placeholder="Post title"
              className="py-1 text-3xl font-bold text-foreground"
            />

            {/* Settings */}
            <PostSettings post={post} decofile={decofile} onChange={setField} />

            <div className="mt-6 border-t" />

            {/* Block document */}
            <div className="mt-2">
              {blocks.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  This post has no content yet. Use ⊕ to add your first block.
                </p>
              )}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={ids}
                  strategy={verticalListSortingStrategy}
                >
                  <InsertBlockDivider
                    blockTypes={blockTypes}
                    onInsert={(rt) => insertAt(0, rt)}
                    alwaysShow={blocks.length === 0}
                  />
                  {blockItems.map(({ id, block: blk }, index) => (
                    <div key={id}>
                      <BlockRow
                        id={id}
                        block={blk}
                        meta={meta}
                        onChange={(v) => updateAt(index, v)}
                        onDelete={() => removeAt(index)}
                      />
                      <InsertBlockDivider
                        blockTypes={blockTypes}
                        onInsert={(rt) => insertAt(index + 1, rt)}
                      />
                    </div>
                  ))}
                </SortableContext>
              </DndContext>
            </div>
          </div>
        </div>
      </div>
    </BlogSandboxProvider>
  );
}

function uid(): string {
  return crypto.randomUUID();
}

function PostSettings({
  post,
  decofile,
  onChange,
}: {
  post: Record<string, unknown>;
  decofile: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
        >
          <Settings01 size={15} />
          <span className="flex-1 text-left">Post settings</span>
          <ChevronDown
            size={15}
            className={cn("transition-transform", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-5 px-2 pt-4">
        <div className="space-y-2">
          <Label htmlFor="post-excerpt">Excerpt</Label>
          <Textarea
            id="post-excerpt"
            value={str(post.excerpt)}
            onChange={(e) => onChange("excerpt", e.target.value)}
            rows={2}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="post-slug">Slug</Label>
            <Input
              id="post-slug"
              value={str(post.slug)}
              onChange={(e) => onChange("slug", e.target.value)}
              placeholder="my-post"
              className="h-10"
            />
          </div>
          <StringField
            schema={{ type: "string", format: "date", title: "Date" }}
            value={str(post.date)}
            onChange={(v) => onChange("date", v)}
            path="post-date"
            label="Date"
          />
        </div>
        <ImageField
          schema={{ type: "string", format: "image-uri", title: "Cover image" }}
          value={post.image}
          onChange={(v) => onChange("image", v)}
          path="post-image"
          label="Cover image"
        />
        <RelationSelect
          label="Authors"
          decofile={decofile}
          kind="authors"
          valueField="email"
          extraFields={["email"]}
          selected={post.authors}
          onChange={(v) => onChange("authors", v)}
        />
        <RelationSelect
          label="Categories"
          decofile={decofile}
          kind="categories"
          valueField="slug"
          extraFields={["slug"]}
          selected={post.categories}
          onChange={(v) => onChange("categories", v)}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Multi-select that links a post to existing Author/Category records.
 * Stores the denormalized subset deco expects (e.g. `{ name, email }`).
 */
function RelationSelect({
  label,
  decofile,
  kind,
  valueField,
  extraFields,
  selected,
  onChange,
}: {
  label: string;
  decofile: Record<string, unknown>;
  kind: "authors" | "categories";
  valueField: string;
  extraFields: string[];
  selected: unknown;
  onChange: (value: Array<Record<string, unknown>>) => void;
}) {
  const records = listBlogPayloads(decofile, kind);
  const valueOf = (payload: Record<string, unknown>, key: string) =>
    str(payload[valueField]) || key;

  const options = records.map(({ key, payload }) => ({
    value: valueOf(payload, key),
    label: str(payload.name) || valueOf(payload, key),
  }));

  const selectedArr = Array.isArray(selected)
    ? (selected as Array<Record<string, unknown>>)
    : [];
  const defaultValue = selectedArr
    .map((s) => str(s[valueField]))
    .filter(Boolean);

  const handleChange = (values: string[]) => {
    onChange(
      values.map((value) => {
        const match = records.find(
          ({ key, payload }) => valueOf(payload, key) === value,
        );
        if (!match) return { name: value, [valueField]: value };
        const out: Record<string, unknown> = { name: str(match.payload.name) };
        for (const f of extraFields) out[f] = match.payload[f] ?? value;
        return out;
      }),
    );
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No {label.toLowerCase()} yet — create some in the{" "}
          {label.toLowerCase()} collection.
        </p>
      ) : (
        <MultiSelect
          options={options}
          defaultValue={defaultValue}
          onValueChange={handleChange}
          placeholder={`Select ${label.toLowerCase()}`}
          maxCount={4}
        />
      )}
    </div>
  );
}

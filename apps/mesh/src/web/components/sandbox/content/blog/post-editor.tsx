import {
  AlertCircle,
  LinkExternal01,
  Pilcrow01,
  Settings01,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { ImageField } from "@/web/components/sections-editor/fields/image-field";
import { StringField } from "@/web/components/sections-editor/fields/string-field";
import { type LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import {
  buildBlogBlock,
  getBlogPayload,
  listBlogPayloads,
  missingPostFields,
  relationPickerState,
  stampPostModified,
} from "./blog-data";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { buildBlogPostPreviewUrl } from "./blog-preview-url";
import { usePackagePath } from "@/web/components/sections-editor/use-package-path";
import { useSaveBlogBlock } from "./use-blog-mutations";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { asBlocks, BlockDocument } from "./block-document";
import {
  AddButton,
  EditableText,
  RemoveButton,
  str,
} from "./blocks/primitives";

type ExtraProp = { key: string; value: string };

function asExtraProps(value: unknown): ExtraProp[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    key: str((item as Record<string, unknown>)?.key),
    value: str((item as Record<string, unknown>)?.value),
  }));
}

/**
 * Notion-style post editor: a large title, then two tabs — Content (the body
 * rendered as a document of inline-editable blocks, on a document "sheet")
 * and Settings (slug/date/authors/categories/…). Each block renders as its
 * content type (paragraph, heading, list, …); a ⊕ between blocks inserts, and
 * a drag handle reorders. Not a schema form.
 */
export function PostEditor({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  block,
  decofile,
  meta,
  previewBaseUrl,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  previewBaseUrl?: string | null;
}) {
  const save = useSaveBlogBlock({
    orgSlug,
    virtualMcpId,
    branch,
    packagePath: usePackagePath(virtualMcpId),
  });
  const initial = getBlogPayload(block, "posts");

  const [post, setPost] = useAutosave(initial, (next) => {
    save.mutate({
      blockKey,
      data: buildBlogBlock(blockKey, "posts", stampPostModified(next)),
    });
  });

  const setField = (key: string, value: unknown) =>
    setPost({ ...post, [key]: value });

  const previewUrl = buildBlogPostPreviewUrl({
    decofile,
    post,
    previewBaseUrl,
  });

  const missing = missingPostFields(post);
  const hasErrors = missing.length > 0;
  const missingLabel = `Missing required ${
    missing.length === 1 ? "field" : "fields"
  }: ${missing.join(", ")}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="truncate text-sm font-medium">
          {str(post.title) || "Untitled post"}
        </span>
        <div className="flex shrink-0 items-center gap-3">
          {hasErrors && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <AlertCircle size={14} />
                  {missing.length} {missing.length === 1 ? "issue" : "issues"}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{missingLabel}</TooltipContent>
            </Tooltip>
          )}
          <SaveStatus isPending={save.isPending} isError={save.isError} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!previewUrl || hasErrors}
            title={
              hasErrors
                ? missingLabel
                : previewUrl
                  ? "Open the post preview in a new tab"
                  : "Set the post slug (and its category) plus the blog app's pageSlug to preview"
            }
            onClick={() => {
              if (previewUrl && !hasErrors) {
                window.open(previewUrl, "_blank", "noopener,noreferrer");
              }
            }}
          >
            <LinkExternal01 size={14} />
            See preview
          </Button>
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">
          {/* Title — wraps onto multiple lines instead of truncating */}
          <EditableText
            value={str(post.title)}
            onChange={(v) => setField("title", v)}
            placeholder="Post title"
            className="py-1 text-4xl font-bold text-foreground"
          />

          {/* Content and Settings are sibling tabs; the body is the default */}
          <Tabs defaultValue="content" className="mt-6 gap-4">
            <TabsList>
              <TabsTrigger value="content">
                <Pilcrow01 />
                Content
              </TabsTrigger>
              <TabsTrigger value="settings">
                <Settings01 />
                Settings
              </TabsTrigger>
            </TabsList>

            <TabsContent value="content">
              <div className="rounded-xl border bg-card p-8 shadow-sm">
                <BlockDocument
                  value={asBlocks(post.sections)}
                  onChange={(next) => setField("sections", next)}
                  meta={meta}
                  sandboxRef={{ orgSlug, virtualMcpId, branch }}
                  emptyMessage="This post has no content yet. Use ⊕ to add your first block."
                />
              </div>
            </TabsContent>

            <TabsContent value="settings">
              <div className="rounded-xl border bg-card p-6 shadow-sm">
                <PostSettings
                  post={post}
                  decofile={decofile}
                  onChange={setField}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
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
  return (
    <div className="space-y-5">
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
      {/* Authors denormalize their FULL record onto the post — the blog app
          renders the author box (type, job title, company, avatar) from it. */}
      <RelationSelect
        label="Authors"
        decofile={decofile}
        kind="authors"
        valueField="email"
        toRef={(author) => ({ ...author })}
        selected={post.authors}
        onChange={(v) => onChange("authors", v)}
      />
      {/* Categories denormalize only `{ name, slug }` — copying the category's
          own body (description, sections) onto every post would bloat them. */}
      <RelationSelect
        label="Categories"
        decofile={decofile}
        kind="categories"
        valueField="slug"
        toRef={(category) => ({
          name: str(category.name),
          slug: str(category.slug),
        })}
        selected={post.categories}
        onChange={(v) => onChange("categories", v)}
      />
      <ExtraPropsField
        value={post.extraProps}
        onChange={(v) => onChange("extraProps", v)}
      />
    </div>
  );
}

function ExtraPropsField({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: ExtraProp[]) => void;
}) {
  const items = asExtraProps(value);
  const set = (i: number, patch: Partial<ExtraProp>) =>
    onChange(items.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      <Label>Extra props</Label>
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((prop, i) => (
            <li key={i} className="group/item flex items-center gap-2">
              <Input
                value={prop.key}
                onChange={(e) => set(i, { key: e.target.value })}
                placeholder="key"
                className="h-9 flex-1"
              />
              <Input
                value={prop.value}
                onChange={(e) => set(i, { value: e.target.value })}
                placeholder="value"
                className="h-9 flex-1"
              />
              <RemoveButton
                label="Remove prop"
                onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              />
            </li>
          ))}
        </ul>
      )}
      <AddButton
        label="Add prop"
        onClick={() => onChange([...items, { key: "", value: "" }])}
      />
    </div>
  );
}

/**
 * Multi-select that links a post to existing Author/Category records.
 * Stores the denormalized ref `toRef` builds from the picked record.
 */
function RelationSelect({
  label,
  decofile,
  kind,
  valueField,
  toRef,
  selected,
  onChange,
}: {
  label: string;
  decofile: Record<string, unknown>;
  kind: "authors" | "categories";
  valueField: string;
  toRef: (payload: Record<string, unknown>) => Record<string, unknown>;
  selected: unknown;
  onChange: (value: unknown[]) => void;
}) {
  const { options, selectedValues, refsForValues } = relationPickerState({
    records: listBlogPayloads(decofile, kind),
    selected,
    valueField,
    toRef,
  });

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
          defaultValue={selectedValues}
          onValueChange={(values) => onChange(refsForValues(values))}
          placeholder={`Select ${label.toLowerCase()}`}
          maxCount={4}
        />
      )}
    </div>
  );
}

import {
  AlertCircle,
  LinkExternal01,
  Pilcrow01,
  Settings01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { MultiSelect } from "@decocms/ui/components/multi-select.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { ImageField } from "@/components/sections-editor/fields/image-field";
import { StringField } from "@/components/sections-editor/fields/string-field";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
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
} from "@decocms/ui/components/tooltip.tsx";
import { buildBlogPostPreviewUrl } from "./blog-preview-url";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useDraftPointer } from "@/components/sections-editor/use-fast-preview-draft-url";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { asBlocks, BlockDocument } from "./block-document";
import {
  AddButton,
  EditableText,
  RemoveButton,
  str,
} from "./blocks/primitives";
import { useT } from "@/i18n/use-t.ts";

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
  const t = useT();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const draftPointer = useDraftPointer({ orgSlug, virtualMcpId, branch });
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
    draftPointer,
  });

  const missing = missingPostFields(post);
  const hasErrors = missing.length > 0;
  const missingLabel =
    missing.length === 1
      ? t("sandbox.postEditor.missingFieldSingular", {
          fields: missing.join(", "),
        })
      : t("sandbox.postEditor.missingFieldPlural", {
          fields: missing.join(", "),
        });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="truncate text-sm font-medium">
          {str(post.title) || t("sandbox.postEditor.untitledPost")}
        </span>
        <div className="flex shrink-0 items-center gap-3">
          {hasErrors && (
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
                  ? t("sandbox.postEditor.previewTooltip")
                  : t("sandbox.postEditor.previewRequiresSlugAndCategory")
            }
            onClick={() => {
              if (previewUrl && !hasErrors) {
                window.open(previewUrl, "_blank", "noopener,noreferrer");
              }
            }}
          >
            <LinkExternal01 size={14} />
            {t("sandbox.postEditor.seePreview")}
          </Button>
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">
          {/* Title — wraps onto multiple lines instead of truncating */}
          <EditableText
            value={str(post.title)}
            onChange={(v) => setField("title", v)}
            placeholder={t("sandbox.postEditor.postTitlePlaceholder")}
            className="py-1 text-4xl font-bold text-foreground"
          />

          {/* Content and Settings are sibling tabs; the body is the default */}
          <Tabs defaultValue="content" className="mt-6 gap-4">
            <TabsList>
              <TabsTrigger value="content">
                <Pilcrow01 />
                {t("sandbox.postEditor.contentTab")}
              </TabsTrigger>
              <TabsTrigger value="settings">
                <Settings01 />
                {t("sandbox.postEditor.settingsTab")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="content">
              <div className="rounded-xl border bg-card p-8 shadow-sm">
                <BlockDocument
                  value={asBlocks(post.sections)}
                  onChange={(next) => setField("sections", next)}
                  meta={meta}
                  sandboxRef={{ orgSlug, virtualMcpId, branch }}
                  emptyMessage={t("sandbox.postEditor.noContentYet")}
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
  const t = useT();
  // Unset status ⇒ published, so posts written before the field stay live.
  const status = str(post.status) || "published";
  const isPublished = status === "published";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 border-b pb-4">
        <div className="flex items-center gap-2">
          <Label>{t("sandbox.postEditor.statusLabel")}</Label>
          <PostStatusBadge status={status} />
        </div>
        <Button
          type="button"
          variant={isPublished ? "outline" : "default"}
          size="sm"
          onClick={() =>
            onChange("status", isPublished ? "draft" : "published")
          }
        >
          {isPublished
            ? t("sandbox.postEditor.unpublishAction")
            : t("sandbox.postEditor.publishAction")}
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="post-excerpt">
          {t("sandbox.postEditor.excerptLabel")}
        </Label>
        <Textarea
          id="post-excerpt"
          value={str(post.excerpt)}
          onChange={(e) => onChange("excerpt", e.target.value)}
          rows={2}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="post-slug">{t("sandbox.postEditor.slugLabel")}</Label>
          <Input
            id="post-slug"
            value={str(post.slug)}
            onChange={(e) => onChange("slug", e.target.value)}
            placeholder={t("sandbox.postEditor.slugPlaceholder")}
            className="h-10"
          />
        </div>
        <StringField
          schema={{
            type: "string",
            format: "date",
            title: t("sandbox.postEditor.dateLabel"),
          }}
          value={str(post.date)}
          onChange={(v) => onChange("date", v)}
          path="post-date"
          label={t("sandbox.postEditor.dateLabel")}
        />
      </div>
      {/* Cover image + its alt text: `alt` is the blog app's alt for `image`,
          and the front falls back to the title when it is empty. */}
      <div className="space-y-2">
        <ImageField
          schema={{
            type: "string",
            format: "image-uri",
            title: t("sandbox.postEditor.coverImageLabel"),
          }}
          value={post.image}
          onChange={(v) => onChange("image", v)}
          path="post-image"
          label={t("sandbox.postEditor.coverImageLabel")}
        />
        <StringField
          schema={{
            type: "string",
            title: t("sandbox.postEditor.coverAltLabel"),
            description: t("sandbox.postEditor.coverAltDescription"),
          }}
          value={str(post.alt)}
          onChange={(v) => onChange("alt", v)}
          path="post-alt"
          label={t("sandbox.postEditor.coverAltLabel")}
        />
      </div>
      {/* Authors denormalize their FULL record onto the post — the blog app
          renders the author box (type, job title, company, avatar) from it. */}
      <RelationSelect
        label={t("sandbox.postEditor.authorsLabel")}
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
        label={t("sandbox.postEditor.categoriesLabel")}
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
      <SeoFields value={post.seo} onChange={(v) => onChange("seo", v)} />
    </div>
  );
}

/**
 * The post's publication state. Only `published` and `draft` are editable here;
 * any other value the blog app writes (`generating`, `awaiting_review`, …) is
 * shown verbatim so the editor never misreports it.
 */
function PostStatusBadge({ status }: { status: string }) {
  const t = useT();
  if (status === "published") {
    return (
      <Badge variant="success">{t("sandbox.postEditor.statusPublished")}</Badge>
    );
  }
  if (status === "draft") {
    return (
      <Badge variant="secondary">{t("sandbox.postEditor.statusDraft")}</Badge>
    );
  }
  return <Badge variant="outline">{status}</Badge>;
}

/**
 * Edits the post's optional `seo` object (the blog app's `Seo` type:
 * title/description/image/canonical/noIndexing). Empty fields fall back to
 * the post's own title/excerpt/cover on the site side, so none is required.
 */
function SeoFields({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const t = useT();
  const seo =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const set = (key: string, v: unknown) => onChange({ ...seo, [key]: v });

  return (
    <div className="space-y-5 border-t pt-5">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {t("sandbox.postEditor.seoSectionLabel")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.postEditor.seoSectionHint")}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="post-seo-title">
          {t("sandbox.postEditor.seoTitleLabel")}
        </Label>
        <Input
          id="post-seo-title"
          value={str(seo.title)}
          onChange={(e) => set("title", e.target.value)}
          className="h-10"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="post-seo-description">
          {t("sandbox.postEditor.seoDescriptionLabel")}
        </Label>
        <Textarea
          id="post-seo-description"
          value={str(seo.description)}
          onChange={(e) => set("description", e.target.value)}
          rows={2}
        />
      </div>
      <ImageField
        schema={{
          type: "string",
          format: "image-uri",
          title: t("sandbox.postEditor.seoImageLabel"),
        }}
        value={seo.image}
        onChange={(v) => set("image", v)}
        path="post-seo-image"
        label={t("sandbox.postEditor.seoImageLabel")}
      />
      <div className="space-y-2">
        <Label htmlFor="post-seo-canonical">
          {t("sandbox.postEditor.seoCanonicalLabel")}
        </Label>
        <Input
          id="post-seo-canonical"
          value={str(seo.canonical)}
          onChange={(e) => set("canonical", e.target.value)}
          placeholder={t("sandbox.postEditor.seoCanonicalPlaceholder")}
          className="h-10"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="post-seo-no-indexing">
          {t("sandbox.postEditor.seoNoIndexingLabel")}
        </Label>
        <Switch
          id="post-seo-no-indexing"
          checked={seo.noIndexing === true}
          onCheckedChange={(checked) => set("noIndexing", checked)}
        />
      </div>
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
  const t = useT();
  const items = asExtraProps(value);
  const set = (i: number, patch: Partial<ExtraProp>) =>
    onChange(items.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      <Label>{t("sandbox.postEditor.extraPropsLabel")}</Label>
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((prop, i) => (
            <li key={i} className="group/item flex items-center gap-2">
              <Input
                value={prop.key}
                onChange={(e) => set(i, { key: e.target.value })}
                placeholder={t("sandbox.postEditor.keyPlaceholder")}
                className="h-9 flex-1"
              />
              <Input
                value={prop.value}
                onChange={(e) => set(i, { value: e.target.value })}
                placeholder={t("sandbox.postEditor.valuePlaceholder")}
                className="h-9 flex-1"
              />
              <RemoveButton
                label={t("sandbox.postEditor.removePropLabel")}
                onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              />
            </li>
          ))}
        </ul>
      )}
      <AddButton
        label={t("sandbox.postEditor.addPropLabel")}
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
  const t = useT();
  const { options, selectedValues, refsForValues } = relationPickerState({
    records: listBlogPayloads(decofile, kind),
    selected,
    valueField,
    toRef,
  });

  const noItemsMsg =
    kind === "authors"
      ? t("sandbox.postEditor.noAuthorsYet")
      : t("sandbox.postEditor.noCategoriesYet");
  const selectPlaceholder =
    kind === "authors"
      ? t("sandbox.postEditor.selectAuthorsPlaceholder")
      : t("sandbox.postEditor.selectCategoriesPlaceholder");

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{noItemsMsg}</p>
      ) : (
        <MultiSelect
          options={options}
          defaultValue={selectedValues}
          onValueChange={(values) => onChange(refsForValues(values))}
          placeholder={selectPlaceholder}
          maxCount={4}
        />
      )}
    </div>
  );
}

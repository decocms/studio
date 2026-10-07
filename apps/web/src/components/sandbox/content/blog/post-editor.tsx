import { useState } from "react";
import { toast } from "sonner";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import {
  AlertCircle,
  Expand01,
  LinkExternal01,
  Minimize01,
  Pilcrow01,
  Settings01,
  Trash01,
  XClose,
} from "@untitledui/icons";
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
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { MultiSelect } from "@decocms/ui/components/multi-select.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { ImageField } from "@/components/sections-editor/fields/image-field";
import { ResponsiveImageField } from "@/components/sections-editor/fields/responsive-image-field";
import { NumberField } from "@/components/sections-editor/fields/number-field";
import { StringField } from "@/components/sections-editor/fields/string-field";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import { CustomFieldsPanel } from "./custom-fields-panel";
import { createReferencedBlockSaver } from "@/components/sections-editor/save-referenced-block";
import {
  blogCustomFieldsSchema,
  KNOWN_POST_FIELDS,
  type KnownPostKey,
} from "./blog-schema";
import {
  buildPostBlock,
  canDeletePost,
  getBlogPayload,
  listBlogPayloads,
  maskSlugInput,
  missingPostFields,
  hasDuplicateName,
  POST_STATUSES,
  type PostStatus,
  postStatus,
  relationPickerState,
  slugifyTitle,
  stampPostModified,
  uniquePostSlug,
} from "./blog-data";
import { POST_STATUS_LABEL, type PostStatusMove } from "./use-post-status-move";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { buildBlogPostPreviewUrl } from "./blog-preview-url";
import { SuggestLinksButton } from "./link-suggestions";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { useDeleteBlock } from "@/components/sections-editor/use-delete-block";
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
  move,
  onClose,
  expanded,
  onToggleExpand,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  previewBaseUrl?: string | null;
  /** Whether the editor is in its full-page form (vs the floating panel). */
  expanded?: boolean;
  /** When set, renders a control that toggles panel ↔ full page. */
  onToggleExpand?: () => void;
  /** When set, renders a close control in the top cluster. */
  onClose?: () => void;
  /** The one status transition, shared with the board — see `usePostStatusMove`. */
  move: PostStatusMove;
}) {
  const t = useT();
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const remove = useDeleteBlock({ orgSlug, virtualMcpId, branch });
  const hasAi = useHostedAiProviderKeys().length > 0;
  const draftPointer = useDraftPointer({ orgSlug, virtualMcpId, branch });
  const initial = getBlogPayload(block, "posts");

  const [post, setPost, syncPost, saveScheduled] = useAutosave(
    initial,
    (next) => {
      save.mutate({
        blockKey,
        data: buildPostBlock(blockKey, stampPostModified(next)),
      });
    },
    { isSaving: save.isPending },
  );

  // A move renamed the block, so drop a pending write aimed at the retired key.
  const [seenBlockKey, setSeenBlockKey] = useState(blockKey);
  if (seenBlockKey !== blockKey) {
    setSeenBlockKey(blockKey);
    syncPost(initial);
  }

  /**
   * Change the status through the shared move, handing it the live draft.
   *
   * `syncPost` first: the move carries the draft itself, so the pending
   * autosave has nothing left to write — and letting it fire would write to a
   * block key the move is about to retire, resurrecting the post's old form.
   */
  const moveStatus = (next: PostStatus) => {
    syncPost(post);
    void move.apply(blockKey, next, post);
  };

  // Key typed from `KNOWN_POST_KEYS`, so a bespoke field absent from it fails to compile.
  const setField = (key: KnownPostKey, value: unknown) =>
    setPost({ ...post, [key]: value });

  const customFields = blogCustomFieldsSchema("posts", meta, KNOWN_POST_FIELDS);

  // Edits to a field pointing at a saved block belong to that block's own
  // decofile entry, not to this post.
  const saveReferencedBlock = createReferencedBlockSaver((refKey, data) =>
    save.mutate({ blockKey: refKey, data }),
  );

  // Remount key: TipTap seeds content once, so an external body rewrite (Suggest links) only shows after a remount. Bumped on apply, never on typing.
  const [contentRevision, setContentRevision] = useState(0);

  const previewUrl = buildBlogPostPreviewUrl({
    decofile,
    post,
    previewBaseUrl,
    draftPointer,
  });

  // Two posts sharing a title is legal but bad for search; warn, never block.
  const hasDuplicateTitle = hasDuplicateName(
    decofile,
    "posts",
    blockKey,
    str(post.title),
  );

  const canDelete = canDeletePost(post);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deletePost = async () => {
    // Cancel the debounce first: a timer that fires after the unlink writes
    // the block straight back.
    syncPost(post);
    try {
      await remove.mutateAsync({ blockKey });
      toast.success(
        t("sandbox.postEditor.deletePostSuccess", { title: str(post.title) }),
      );
      setConfirmingDelete(false);
      onClose?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.postEditor.deletePostFailed"),
      );
    }
  };

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
    <div className="relative flex h-full flex-col">
      <div className="absolute inset-x-0 top-0 z-10 bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-2 px-8 py-3">
          <div className="flex items-center gap-3">
            <SaveStatus
              isPending={save.isPending || saveScheduled}
              isError={save.isError}
            />
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
          </div>
          {(onToggleExpand || onClose) && (
            <div className="-mr-2 flex items-center gap-0.5">
              {onToggleExpand && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-2 text-muted-foreground"
                  onClick={onToggleExpand}
                  title={
                    expanded
                      ? t("sandbox.postBoard.collapse")
                      : t("sandbox.postBoard.expand")
                  }
                >
                  {expanded ? <Minimize01 size={16} /> : <Expand01 size={16} />}
                </Button>
              )}
              {onClose && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-2 text-muted-foreground"
                  onClick={onClose}
                  title={t("sandbox.postBoard.close")}
                >
                  <XClose size={16} />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 pb-6 pt-14">
          {/* Title — wraps onto multiple lines instead of truncating */}
          <EditableText
            value={str(post.title)}
            onChange={(v) => setField("title", v)}
            placeholder={t("sandbox.postEditor.postTitlePlaceholder")}
            className="py-1 text-4xl font-bold text-foreground"
          />
          {hasDuplicateTitle && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
              <AlertCircle size={14} className="mt-px shrink-0" />
              {t("sandbox.postEditor.duplicateTitleWarning")}
            </p>
          )}

          {/* Content and Settings are sibling tabs; the body is the default. The
              tab row also carries the save state + preview, so no top chrome. */}
          <Tabs defaultValue="content" className="mt-6 gap-4">
            <div className="flex items-center justify-between gap-3">
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
              <div className="flex shrink-0 items-center gap-3">
                {canDelete && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="px-2 text-muted-foreground hover:text-destructive"
                        aria-label={t("sandbox.postEditor.deletePost")}
                        onClick={() => setConfirmingDelete(true)}
                      >
                        <Trash01 size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {t("sandbox.postEditor.deletePost")}
                    </TooltipContent>
                  </Tooltip>
                )}
                <SuggestLinksButton
                  decofile={decofile}
                  sections={asBlocks(post.sections)}
                  currentKey={blockKey}
                  hasAi={hasAi}
                  onApply={(next) => {
                    setField("sections", next);
                    setContentRevision((r) => r + 1);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!previewUrl}
                  title={
                    previewUrl
                      ? t("sandbox.postEditor.previewTooltip")
                      : t("sandbox.postEditor.previewRequiresSlugAndCategory")
                  }
                  onClick={() => {
                    if (previewUrl) {
                      window.open(previewUrl, "_blank", "noopener,noreferrer");
                    }
                  }}
                >
                  <LinkExternal01 size={14} />
                  {t("sandbox.postEditor.seePreview")}
                </Button>
              </div>
            </div>

            <TabsContent value="content">
              <div className="rounded-xl border bg-card p-8 shadow-sm">
                <BlockDocument
                  key={contentRevision}
                  value={asBlocks(post.sections)}
                  onChange={(next) => setField("sections", next)}
                  meta={meta}
                  decofile={decofile}
                  sandboxRef={{ orgSlug, virtualMcpId, branch, threadId }}
                  previewBaseUrl={previewBaseUrl}
                  onSaveReferencedBlock={saveReferencedBlock}
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
                  blockKey={blockKey}
                  move={move}
                  onMoveStatus={moveStatus}
                />
                <CustomFieldsPanel
                  schema={customFields}
                  value={post}
                  onChange={setPost}
                  basePath="post"
                  meta={meta}
                  decofile={decofile}
                  sandbox={{ orgSlug, virtualMcpId, branch, threadId }}
                  onSaveReferencedBlock={saveReferencedBlock}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <AlertDialog
        open={confirmingDelete}
        onOpenChange={(next) => {
          if (!next && !remove.isPending) setConfirmingDelete(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sandbox.postEditor.deletePostConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sandbox.postEditor.deletePostConfirmBody", {
                title: str(post.title) || t("sandbox.postBoard.untitled"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              {t("sandbox.postEditor.deletePostCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void deletePost();
              }}
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {remove.isPending ? (
                <>
                  <Spinner className="size-3.5" />
                  {t("sandbox.postEditor.deletingPost")}
                </>
              ) : (
                t("sandbox.postEditor.deletePost")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The board's lanes as a control, gated by the same `move.refuse`. */
function StatusPicker({
  blockKey,
  post,
  move,
  onMoveStatus,
}: {
  blockKey: string;
  post: Record<string, unknown>;
  move: PostStatusMove;
  onMoveStatus: (next: PostStatus) => void;
}) {
  const t = useT();
  const current = postStatus(post);
  // `generating` belongs to a generation run — shown only while the post is in it.
  const options = POST_STATUSES.filter(
    (status) => status !== "generating" || current === "generating",
  );
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((status) => {
        const active = status === current;
        const refusal = active ? null : move.refuse(blockKey, status, post);
        return (
          <Tooltip key={status}>
            <TooltipTrigger asChild>
              <span>
                <button
                  type="button"
                  disabled={!!refusal}
                  aria-pressed={active}
                  onClick={() => onMoveStatus(status)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "cursor-pointer bg-card hover:bg-muted",
                    refusal && "cursor-not-allowed opacity-50",
                  )}
                >
                  {t(POST_STATUS_LABEL[status])}
                </button>
              </span>
            </TooltipTrigger>
            {refusal && (
              <TooltipContent side="bottom">
                {move.reasonText(refusal)}
              </TooltipContent>
            )}
          </Tooltip>
        );
      })}
    </div>
  );
}

function PostSettings({
  post,
  decofile,
  onChange,
  blockKey,
  move,
  onMoveStatus,
}: {
  post: Record<string, unknown>;
  decofile: Record<string, unknown>;
  onChange: (key: KnownPostKey, value: unknown) => void;
  blockKey: string;
  move: PostStatusMove;
  onMoveStatus: (next: PostStatus) => void;
}) {
  const t = useT();
  const status = postStatus(post);
  const isScheduled = status === "scheduled";

  // Committed on blur, not per keystroke: a half-typed slug must not autosave.
  const committedSlug = str(post.slug);
  const [slugDraft, setSlugDraft] = useState(committedSlug);
  const [slugNotice, setSlugNotice] = useState<string | null>(null);
  // Re-seed when the slug changes under us (AI generation, another session).
  const [seenSlug, setSeenSlug] = useState(committedSlug);
  if (seenSlug !== committedSlug) {
    setSeenSlug(committedSlug);
    setSlugDraft(committedSlug);
  }

  /** Blur handler: normalize, then suffix the slug if another post owns it. */
  const commitSlugFromDraft = () => {
    const normalized = slugifyTitle(slugDraft);
    setSlugDraft(normalized);
    // Blurring without having touched the field must not queue a write.
    if (normalized === committedSlug) return;
    // Stays empty: `missingPostFields` flags it, inventing one hides the gap.
    if (!normalized) {
      setSlugNotice(null);
      onChange("slug", "");
      return;
    }
    const taken = listBlogPayloads(decofile, "posts")
      .filter((entry) => entry.key !== blockKey)
      .map((entry) => str(entry.payload.slug))
      .filter(Boolean);
    if (!taken.includes(normalized)) {
      setSlugNotice(null);
      onChange("slug", normalized);
      return;
    }
    const fixed = uniquePostSlug(normalized, taken);
    const message = t("sandbox.postEditor.slugDeduped", { slug: fixed });
    setSlugDraft(fixed);
    // Inline too: a dismissed toast would hide that the URL changed.
    setSlugNotice(message);
    toast.info(message);
    onChange("slug", fixed);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-4 border-b pb-4">
        <div className="space-y-2">
          <Label>{t("sandbox.postEditor.statusLabel")}</Label>
          <StatusPicker
            blockKey={blockKey}
            post={post}
            move={move}
            onMoveStatus={onMoveStatus}
          />
        </div>
        {isScheduled && (
          <StringField
            schema={{
              type: "string",
              format: "date-time",
              title: t("sandbox.postEditor.scheduledDatetimeLabel"),
              description: t("sandbox.postEditor.scheduledDatetimeDescription"),
            }}
            value={str(post.scheduledDatetime)}
            onChange={(v) => onChange("scheduledDatetime", v)}
            path="post-scheduled-datetime"
            label={t("sandbox.postEditor.scheduledDatetimeLabel")}
          />
        )}
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
            value={slugDraft}
            onChange={(e) => {
              setSlugNotice(null);
              setSlugDraft(maskSlugInput(e.target.value));
            }}
            onBlur={commitSlugFromDraft}
            placeholder={t("sandbox.postEditor.slugPlaceholder")}
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
        {/* The blog app's `readTime`, in minutes — nothing computes it, so an
            empty value means the site shows no estimate. */}
        <NumberField
          schema={{
            type: "integer",
            title: t("sandbox.postEditor.readTimeLabel"),
          }}
          value={typeof post.readTime === "number" ? post.readTime : undefined}
          onChange={(v) => onChange("readTime", v)}
          path="post-read-time"
          label={t("sandbox.postEditor.readTimeLabel")}
        />
      </div>
      {/* Cover image + its alt text: `alt` is the blog app's alt for `image`,
          and the front falls back to the title when it is empty. */}
      <div className="space-y-2">
        <ResponsiveImageField
          value={post.image}
          mobileValue={post.mobileImage}
          onChange={(v) => onChange("image", v)}
          onMobileChange={(v) => onChange("mobileImage", v)}
          alt={str(post.alt)}
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

/**
 * The Posts area: one workspace with two views of the same lifecycle — a Kanban
 * Board (lanes by status, drag to advance) and a grouped List (by status by
 * default, switchable to format or pillar). Opening a post swaps to the editor;
 * the caller renders that with a Back button. Statuses are the blog app's own
 * `PostStatus` vocabulary; deleting a post is a soft delete into Archived.
 */
import { type ReactNode, Suspense, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarDate,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Columns03,
  List,
  Loading02,
  Pilcrow01,
  Plus,
  Stars02,
  Trash01,
  Upload01,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useLocalStorage } from "@/hooks/use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useDeleteBlock } from "@/components/sections-editor/use-delete-block";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import { GeneratePostDialog, type IdeaSeed } from "./generate-post-dialog";
import { useGeneratePost } from "./use-generate-post";
import {
  APPS_UPDATE_COMMAND,
  type BlogSupport,
  postStatusUnsupported,
} from "./blog-capabilities";
import { POST_STATUS_LABEL, type PostStatusMove } from "./use-post-status-move";
import {
  BRAND_BLOCK_KEY,
  buildIdeaBlock,
  buildPlanningPostBlock,
  dedupeSuggestedThemes,
  emptyDraftPostPayload,
  filledBrandRules,
  FORMATS_BLOCK_KEY,
  getBlogPayload,
  type IdeaEntry,
  listAllPostsWithMeta,
  listBlogPayloads,
  newIdeaKey,
  newPostId,
  normalizeBrandRules,
  planningMeta,
  planningPostKey,
  scanIdeas,
  scanPillars,
  type PostMeta,
  type PostStatus,
  POST_STATUSES,
  sectionResolveTypes,
} from "./blog-data";
import {
  buildImportedPostPayload,
  looksLikeHtml,
  parseImportedContent,
  sectionsToBlocks,
} from "./import-content";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { PickList, str } from "./blocks/primitives";
import {
  PostFilterBar,
  PostSelectionToolbar,
  type PostSort,
} from "./post-toolbar";

export type PostsView = "board" | "list";
const STATUS_VARIANT: Record<
  PostStatus,
  "secondary" | "warning" | "success" | "outline"
> = {
  draft: "outline",
  generating: "secondary",
  awaiting_review: "warning",
  scheduled: "secondary",
  published: "success",
  archived: "outline",
};

/** The ideas tray collapses like a lane, but has no status of its own. */
const IDEAS_LANE = "ideas";

/** Go-live instant of a post (ISO, so lexical order is chronological). */
const postDateKey = (post: PostMeta) =>
  post.scheduledDatetime || post.date || "";

/** Newest first — for the scheduled and published lanes/groups. */
const byDateDesc = (a: PostMeta, b: PostMeta) =>
  postDateKey(b).localeCompare(postDateKey(a));

/** These statuses read as a timeline; everything else keeps its natural order. */
const isDatedStatus = (status: PostStatus) =>
  status === "scheduled" || status === "published";

/** Drag payload key — the dragged post's block key. */
const DRAG_KEY = "application/x-post-key";

export function PostsWorkspace({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  view,
  selectedKey,
  onViewChange,
  onOpen,
  onClose,
  move,
  support,
  meta,
  renderDetail,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  view: PostsView;
  /** The open post — a highlighted row in list mode, an open drawer in board mode. */
  selectedKey?: string | null;
  onViewChange: (view: PostsView) => void;
  onOpen: (key: string) => void;
  /** Close the board's post drawer. */
  onClose?: () => void;
  /** The shared status transition — the same one the editor's control uses. */
  move: PostStatusMove;
  /** What this site's blog app can honour — gates the live lanes. */
  support: BlogSupport;
  /** Live schema — which section kinds generation may write. */
  meta: LiveMeta;
  /** Renders the open post — the list's right pane or the board's floating panel. */
  renderDetail?: (
    key: string,
    controls?: {
      expanded?: boolean;
      onToggleExpand?: () => void;
      onClose?: () => void;
    },
  ) => ReactNode;
}) {
  const t = useT();
  const studio = useStudioTools();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const deleteBlock = useDeleteBlock({ orgSlug, virtualMcpId, branch });
  const hasAi = useHostedAiProviderKeys().length > 0;

  const [dragOverLane, setDragOverLane] = useState<PostStatus | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [count, setCount] = useState(3);
  const [ideaPillarKey, setIdeaPillarKey] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateSeed, setGenerateSeed] = useState<IdeaSeed | undefined>();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // Lanes by status, not by index: a reordered board can't reopen the wrong one.
  const [collapsedLanes, setCollapsedLanes] = useLocalStorage<string[]>(
    LOCALSTORAGE_KEYS.blogBoardCollapsedLanes(),
    [],
  );
  const toggleLane = (lane: string) =>
    setCollapsedLanes((prev) =>
      prev.includes(lane)
        ? prev.filter((entry) => entry !== lane)
        : [...prev, lane],
    );

  const generatePost = useGeneratePost({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
    onStarted: onOpen,
  });

  const posts = listAllPostsWithMeta(decofile);
  const ideas = scanIdeas(decofile);
  const pillars = scanPillars(decofile);
  const pillarTitleOf = (key?: string) =>
    pillars.find((pillar) => pillar.key === key)?.title;
  const payloadOf = (key: string) =>
    getBlogPayload(
      decofile[key] as Record<string, unknown> | undefined,
      "posts",
    );
  // List mode shows the first post by default, so the detail pane is never empty.
  const detailKey =
    selectedKey && posts.some((p) => p.key === selectedKey)
      ? selectedKey
      : (posts[0]?.key ?? null);

  /**
   * Delete is a soft delete: the post moves to Archived, off every working
   * lane but still recoverable by dragging it back out.
   */
  const archivePost = async (post: PostMeta) => {
    if (await move.apply(post.key, "archived")) {
      toast.success(t("sandbox.postBoard.archived"));
    }
  };

  // -- List view: filter, sort, selection -------------------------------------

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PostStatus | null>(null);
  const [sort, setSort] = useState<PostSort>("date-desc");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  /** Counts describe the whole blog, not the current filter — a option showing
   *  0 is the answer to "is there anything under this?", so it must not vanish. */
  const statusCounts = posts.reduce<Partial<Record<PostStatus, number>>>(
    (counts, post) => {
      counts[post.status] = (counts[post.status] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const countBy = (pick: (post: PostMeta) => string[]) => {
    const counts = new Map<string, number>();
    for (const post of posts) {
      for (const value of pick(post)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return counts;
  };
  const categoryCounts = countBy((post) => post.categorySlugs);
  const authorCounts = countBy((post) => post.authorEmails);
  const categoryOptions = listBlogPayloads(decofile, "categories").map(
    ({ payload }) => ({
      slug: str(payload.slug),
      name: str(payload.name) || str(payload.slug),
      count: categoryCounts.get(str(payload.slug)) ?? 0,
    }),
  );
  const authorOptions = listBlogPayloads(decofile, "authors").map(
    ({ payload }) => ({
      email: str(payload.email),
      name: str(payload.name) || str(payload.email),
      count: authorCounts.get(str(payload.email)) ?? 0,
    }),
  );

  const listedPosts = posts
    .filter((p) => !categoryFilter || p.categorySlugs.includes(categoryFilter))
    .filter((p) => !authorFilter || p.authorEmails.includes(authorFilter))
    .filter((p) => !statusFilter || p.status === statusFilter)
    .sort((a, b) => {
      if (sort === "az") return a.title.localeCompare(b.title);
      if (sort === "za") return b.title.localeCompare(a.title);
      // ISO dates sort lexically; a post with no date sinks to the bottom.
      const cmp = (a.scheduledDatetime || a.date).localeCompare(
        b.scheduledDatetime || b.date,
      );
      return sort === "date-asc" ? cmp : -cmp;
    });

  const selectionActive = selectedKeys.size > 0;
  const toggleSelect = (key: string) =>
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const toggleSelectAll = () =>
    setSelectedKeys((prev) =>
      listedPosts.every((p) => prev.has(p.key))
        ? new Set()
        : new Set(listedPosts.map((p) => p.key)),
    );

  /** Sequential on purpose: concurrent decofile writes overwrite each other. */
  const archiveSelected = async () => {
    let archived = 0;
    for (const key of selectedKeys) {
      if (await move.apply(key, "archived")) archived += 1;
    }
    setSelectedKeys(new Set());
    if (archived > 0) toast.success(t("sandbox.postBoard.archived"));
  };

  /**
   * Write a post from an idea already on the board. The idea stays where it is:
   * one idea is worth several posts, and consuming it would hide that.
   */
  const generateFromIdea = (idea: IdeaEntry) => {
    setGenerateSeed({ key: idea.key, title: idea.title, body: idea.body });
    setGenerateOpen(true);
  };

  const deleteIdea = (idea: IdeaEntry) => {
    deleteBlock.mutate({ blockKey: idea.key });
  };

  const onDrop = (next: PostStatus, key: string) => {
    setDragOverLane(null);
    void move.apply(key, next);
  };

  const writePost = () => {
    const key = planningPostKey(newPostId());
    const payload = emptyDraftPostPayload({ title: "", now: new Date() });
    save.mutate({ blockKey: key, data: buildPlanningPostBlock(key, payload) });
    onOpen(key);
  };

  /**
   * Import externally-authored HTML/Markdown into a review-ready post — no AI,
   * no credits. Parsed onto the site's own blocks so it renders on-brand.
   */
  const importContent = () => {
    const parsed = parseImportedContent(importText);
    const blocks = sectionsToBlocks(parsed.sections, sectionResolveTypes(meta));
    if (blocks.length === 0 && !parsed.title.trim()) {
      toast.error(t("sandbox.postBoard.importEmpty"));
      return;
    }
    const key = planningPostKey(newPostId());
    const payload = buildImportedPostPayload({
      title: parsed.title,
      blocks,
      takenSlugs: posts.map((p) => p.slug).filter(Boolean),
      now: new Date(),
    });
    save.mutate({ blockKey: key, data: buildPlanningPostBlock(key, payload) });
    setImportOpen(false);
    setImportText("");
    toast.success(t("sandbox.postBoard.imported"));
    onOpen(key);
  };

  /** Propose ideas from the brand context and drop them into the ideas tray. */
  const generateIdeas = async () => {
    setIsGenerating(true);
    const pillar = pillars.find((entry) => entry.key === ideaPillarKey);
    try {
      const brand =
        (decofile[BRAND_BLOCK_KEY] as Record<string, unknown>) ?? {};
      const formatsBlock = decofile[FORMATS_BLOCK_KEY] as
        | Record<string, unknown>
        | undefined;
      const formatNames = normalizeBrandRules(formatsBlock?.formats)
        .map((f) => f.name)
        .filter(Boolean);
      const result = await studio.call("BLOG_THEME_SUGGEST", {
        brand: {
          companyName: str(brand.companyName),
          description: str(brand.description),
          language: str(brand.language),
          tone: str(brand.tone),
          targetAudience: str(brand.targetAudience),
          values: filledBrandRules(normalizeBrandRules(brand.values)),
          dos: filledBrandRules(normalizeBrandRules(brand.dos)),
          avoid: filledBrandRules(normalizeBrandRules(brand.avoid)),
        },
        existingTitles: ideas.map((idea) => idea.title).filter(Boolean),
        formats: formatNames,
        guidance:
          [
            pillar &&
              `Every idea must be one angle inside the pillar "${pillar.title}": ${pillar.body}`,
            guidance.trim(),
          ]
            .filter(Boolean)
            .join("\n\n") || undefined,
        count,
      });

      const fresh = dedupeSuggestedThemes(
        ideas.map((idea) => idea.title),
        result.themes,
      );
      if (fresh.length === 0) {
        toast.info(t("sandbox.postBoard.ideasFailed"));
        return;
      }

      let created = 0;
      // One at a time — parallel writes race the fast-preview decofile cache.
      for (const idea of fresh) {
        const key = newIdeaKey();
        try {
          await save.mutateAsync({
            blockKey: key,
            data: buildIdeaBlock(key, {
              title: idea.title,
              body: idea.body,
              pillarKey: pillar?.key,
              createdAt: new Date().toISOString(),
            }),
          });
          created++;
        } catch (err) {
          console.warn("[posts] could not save a generated idea", err);
        }
      }
      if (created === 0) {
        toast.error(t("sandbox.postBoard.ideasFailed"));
        return;
      }
      toast.success(
        t("sandbox.postBoard.ideasAdded", { count: String(created) }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.postBoard.ideasFailed"),
      );
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
            <ToggleButton
              active={view === "board"}
              onClick={() => onViewChange("board")}
              icon={<Columns03 size={14} />}
              label={t("sandbox.postBoard.viewBoard")}
            />
            <ToggleButton
              active={view === "list"}
              onClick={() => onViewChange("list")}
              icon={<List size={14} />}
              label={t("sandbox.postBoard.viewList")}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isGenerating && (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              aria-live="polite"
              role="status"
            >
              <Loading02 size={12} className="animate-spin" />
              {t("sandbox.postBoard.generatingLabel")}
            </span>
          )}
          <Dialog open={askOpen} onOpenChange={setAskOpen}>
            <DialogTrigger asChild>
              {/* Off until idea generation is good enough; trigger stays wired. */}
              <Button type="button" variant="outline" size="sm" disabled>
                <Stars02 size={14} />
                {t("sandbox.postBoard.generateIdeas")}
                <Badge variant="secondary">{t("common.soon")}</Badge>
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>
                  {t("sandbox.postBoard.generateIdeas")}
                </DialogTitle>
                <DialogDescription>
                  {t("sandbox.postBoard.ideaGuidanceLabel")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <Textarea
                  id="idea-guidance"
                  value={guidance}
                  rows={6}
                  autoFocus
                  onChange={(e) => setGuidance(e.target.value)}
                  placeholder={t("sandbox.postBoard.ideaGuidancePlaceholder")}
                  className="resize-none text-sm"
                />
                {pillars.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {t("sandbox.postBoard.ideaPillarLabel")}
                    </Label>
                    <PickList
                      options={pillars.map((pillar) => pillar.title)}
                      value={
                        pillars.find((pillar) => pillar.key === ideaPillarKey)
                          ?.title ?? ""
                      }
                      emptyLabel={t("sandbox.postBoard.ideaNoPillar")}
                      onChange={(title) =>
                        setIdeaPillarKey(
                          pillars.find((pillar) => pillar.title === title)
                            ?.key ?? "",
                        )
                      }
                    />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Label htmlFor="idea-count" className="text-xs">
                    {t("sandbox.postBoard.ideaCount")}
                  </Label>
                  <Input
                    id="idea-count"
                    type="number"
                    min={1}
                    max={8}
                    value={count}
                    onChange={(e) =>
                      setCount(
                        Math.max(1, Math.min(8, Number(e.target.value) || 1)),
                      )
                    }
                    className="h-9 w-16"
                  />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t("sandbox.postBoard.usesCredits")}
                  </span>
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  onClick={() => {
                    setAskOpen(false);
                    void generateIdeas();
                  }}
                >
                  <Stars02 size={14} />
                  {t("sandbox.postBoard.generateIdeas")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm">
                <Plus size={14} />
                {t("sandbox.postBoard.newPost")}
                <ChevronDown size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* Off until generation is good enough; the handler stays wired. */}
              <DropdownMenuItem
                disabled
                onClick={() => {
                  setGenerateSeed(undefined);
                  setGenerateOpen(true);
                }}
              >
                <Stars02 size={14} />
                <div className="flex flex-col">
                  <span className="flex items-center gap-1.5">
                    {t("sandbox.postBoard.newPostGenerate")}
                    <Badge variant="secondary">{t("common.soon")}</Badge>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("sandbox.postBoard.newPostGenerateHint")}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={writePost}>
                <Pilcrow01 size={14} />
                <div className="flex flex-col">
                  <span>{t("sandbox.postBoard.newPostWrite")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("sandbox.postBoard.newPostWriteHint")}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setImportOpen(true)}>
                <Upload01 size={14} />
                <div className="flex flex-col">
                  <span>{t("sandbox.postBoard.importContent")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("sandbox.postBoard.importContentHint")}
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <GeneratePostDialog
            key={generateSeed?.title ?? "scratch"}
            open={generateOpen}
            onOpenChange={setGenerateOpen}
            decofile={decofile}
            hasAi={hasAi}
            seed={generateSeed}
            onGenerate={(briefing) => void generatePost(briefing)}
          />
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogContent className="max-h-[85vh] sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t("sandbox.postBoard.importTitle")}</DialogTitle>
                <DialogDescription>
                  {t("sandbox.postBoard.importDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {/* A code editor, not a textarea: the paste is a whole HTML
                    document, and `field-sizing-content` grew the box to the
                    width of its longest line, painting out over the dialog.
                    This one wraps, highlights, and owns its own scrolling. */}
                <div className="h-72 overflow-hidden rounded-[var(--studio-control-radius,var(--radius-xl))] border bg-[var(--studio-input-background)]">
                  <MonacoCodeEditor
                    code={importText}
                    language={looksLikeHtml(importText) ? "html" : "markdown"}
                    height="100%"
                    autoFocus
                    onChange={(value) => setImportText(value ?? "")}
                  />
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".html,.htm,.md,.markdown,.txt"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setImportText(await file.text());
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload01 size={14} />
                  {t("sandbox.postBoard.importUpload")}
                </Button>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  disabled={!importText.trim()}
                  onClick={importContent}
                >
                  <Upload01 size={14} />
                  {t("sandbox.postBoard.importRun")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {posts.length === 0 && ideas.length === 0 ? (
        <EmptyState
          className="flex-1"
          icon={<Stars02 size={22} />}
          title={t("sandbox.postBoard.emptyTitle")}
          description={t("sandbox.postBoard.emptyDescription")}
          buttonProps={{
            children: t("sandbox.postBoard.newPost"),
            onClick: writePost,
          }}
        />
      ) : view === "board" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
          <IdeaTray
            ideas={ideas}
            collapsed={collapsedLanes.includes(IDEAS_LANE)}
            pillarTitleOf={pillarTitleOf}
            onToggleCollapsed={() => toggleLane(IDEAS_LANE)}
            onGenerate={generateFromIdea}
            onDelete={deleteIdea}
          />
          <div
            aria-hidden
            className="my-1 w-px shrink-0 self-stretch bg-border"
          />
          {POST_STATUSES.map((status) => {
            const lanePosts = posts.filter((p) => p.status === status);
            if (isDatedStatus(status)) lanePosts.sort(byDateDesc);
            const laneLabel = t(POST_STATUS_LABEL[status]);
            const isCollapsed = collapsedLanes.includes(status);
            const unsupported = postStatusUnsupported(support, status);
            return (
              <div
                key={status}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverLane(status);
                }}
                onDragLeave={() =>
                  setDragOverLane((l) => (l === status ? null : l))
                }
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(status, e.dataTransfer.getData(DRAG_KEY));
                }}
                title={
                  unsupported
                    ? t("sandbox.postBoard.moveUnsupported", {
                        required: unsupported.required,
                        command: APPS_UPDATE_COMMAND,
                      })
                    : undefined
                }
                className={cn(
                  "flex shrink-0 flex-col rounded-xl border bg-muted/30 transition-colors",
                  isCollapsed ? "w-11" : "w-72",
                  // Dimmed, not hidden: the lane still explains why it's out of reach.
                  unsupported && "opacity-50",
                  dragOverLane === status && "border-primary bg-primary/5",
                )}
              >
                {isCollapsed ? (
                  // Still a drop target, so a post can be dropped onto a closed lane.
                  <button
                    type="button"
                    onClick={() => toggleLane(status)}
                    aria-label={t("sandbox.postBoard.expandLane", {
                      lane: laneLabel,
                    })}
                    aria-expanded={false}
                    className="flex min-h-0 flex-1 cursor-pointer flex-col items-center gap-2 py-2.5 text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight size={14} className="shrink-0" />
                    <span className="text-xs tabular-nums">
                      {lanePosts.length}
                    </span>
                    <span className="[writing-mode:vertical-rl] text-sm font-medium">
                      {laneLabel}
                    </span>
                  </button>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium">
                      <button
                        type="button"
                        onClick={() => toggleLane(status)}
                        aria-label={t("sandbox.postBoard.collapseLane", {
                          lane: laneLabel,
                        })}
                        aria-expanded
                        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left hover:text-muted-foreground"
                      >
                        <ChevronDown size={14} className="shrink-0" />
                        <span className="truncate">{laneLabel}</span>
                      </button>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {lanePosts.length}
                      </span>
                    </div>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                      {lanePosts.length === 0 ? (
                        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                          {t("sandbox.postBoard.laneEmpty")}
                        </p>
                      ) : (
                        lanePosts.map((post) => (
                          <PostCard
                            key={post.key}
                            post={post}
                            payload={payloadOf(post.key)}
                            moving={move.isMoving(post.key)}
                            onOpen={() => onOpen(post.key)}
                            onArchive={
                              post.status === "archived"
                                ? undefined
                                : () => void archivePost(post)
                            }
                          />
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-80 shrink-0 flex-col border-r">
            {selectionActive ? (
              <PostSelectionToolbar
                count={selectedKeys.size}
                allSelected={
                  listedPosts.length > 0 &&
                  listedPosts.every((p) => selectedKeys.has(p.key))
                }
                onToggleSelectAll={toggleSelectAll}
                onArchive={() => void archiveSelected()}
                onExit={() => setSelectedKeys(new Set())}
              />
            ) : (
              <PostFilterBar
                categories={categoryOptions}
                authors={authorOptions}
                statusCounts={statusCounts}
                categoryFilter={categoryFilter}
                authorFilter={authorFilter}
                statusFilter={statusFilter}
                sort={sort}
                onCategoryFilterChange={setCategoryFilter}
                onAuthorFilterChange={setAuthorFilter}
                onStatusFilterChange={setStatusFilter}
                onSortChange={setSort}
              />
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <PostList
                posts={listedPosts}
                selectedKey={detailKey}
                selectionActive={selectionActive}
                selectedKeys={selectedKeys}
                onToggleSelect={toggleSelect}
                onOpen={onOpen}
                isMoving={move.isMoving}
                onArchive={(post) => void archivePost(post)}
              />
            </div>
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            {detailKey && renderDetail ? (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Loading02
                      size={20}
                      className="animate-spin text-muted-foreground"
                    />
                  </div>
                }
              >
                {renderDetail(detailKey)}
              </Suspense>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t("sandbox.postBoard.selectPrompt")}
              </div>
            )}
          </div>
        </div>
      )}

      {view === "board" && selectedKey && expanded && renderDetail && (
        <div className="absolute inset-0 z-30 flex flex-col bg-background">
          {renderDetail(selectedKey, {
            expanded: true,
            onToggleExpand: () => setExpanded(false),
            onClose: () => {
              setExpanded(false);
              onClose?.();
            },
          })}
        </div>
      )}

      <Dialog
        open={view === "board" && !!selectedKey && !expanded}
        onOpenChange={(open) => {
          if (!open) {
            setExpanded(false);
            onClose?.();
          }
        }}
      >
        <DialogContent
          closeButtonClassName="hidden"
          className="left-auto right-4 top-4 bottom-4 flex h-auto translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        >
          <DialogTitle className="sr-only">
            {t("sandbox.collectionsSidebar.posts")}
          </DialogTitle>
          {selectedKey && renderDetail ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Loading02
                    size={20}
                    className="animate-spin text-muted-foreground"
                  />
                </div>
              }
            >
              {renderDetail(selectedKey, {
                expanded: false,
                onToggleExpand: () => setExpanded(true),
                onClose: () => onClose?.(),
              })}
            </Suspense>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function PostList({
  posts,
  selectedKey,
  selectionActive,
  selectedKeys,
  onToggleSelect,
  onOpen,
  isMoving,
  onArchive,
}: {
  /** Already filtered and sorted by the toolbar — rendered in order. */
  posts: PostMeta[];
  selectedKey?: string | null;
  selectionActive: boolean;
  selectedKeys: Set<string>;
  onToggleSelect: (key: string) => void;
  onOpen: (key: string) => void;
  isMoving: (key: string) => boolean;
  onArchive: (post: PostMeta) => void;
}) {
  return (
    <ul className="divide-y">
      {posts.map((post) => (
        <PostRow
          key={post.key}
          post={post}
          selected={post.key === selectedKey}
          selectionActive={selectionActive}
          checked={selectedKeys.has(post.key)}
          onToggleSelect={() => onToggleSelect(post.key)}
          moving={isMoving(post.key)}
          onOpen={() => onOpen(post.key)}
          onArchive={
            post.status === "archived" ? undefined : () => onArchive(post)
          }
        />
      ))}
    </ul>
  );
}

function PostRow({
  post,
  selected,
  selectionActive,
  checked,
  onToggleSelect,
  moving,
  onOpen,
  onArchive,
}: {
  post: PostMeta;
  selected: boolean;
  /** Any post is selected, so a row click picks instead of opening. */
  selectionActive: boolean;
  checked: boolean;
  onToggleSelect: () => void;
  /** A move for this post is in flight — freeze the delete action. */
  moving: boolean;
  onOpen: () => void;
  /** Omitted for a post that is already archived — there is nothing to archive. */
  onArchive?: () => void;
}) {
  const t = useT();
  const hasIssues =
    post.status === "awaiting_review" && post.missing.length > 0;
  const hasDate = post.status === "scheduled" || post.status === "published";
  return (
    <li className="group/row relative">
      {/* Revealed on hover until something is picked, then always shown. */}
      <span
        className={cn(
          "absolute left-3 top-3 z-10 transition-opacity",
          selectionActive || checked
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100 group-hover/row:opacity-100",
        )}
      >
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggleSelect()}
          aria-label={post.title || t("sandbox.postBoard.untitled")}
        />
      </span>
      {onArchive && !selectionActive && (
        <ArchiveButton
          onArchive={onArchive}
          disabled={moving}
          className="top-2.5"
        />
      )}
      <button
        type="button"
        onClick={() => (selectionActive ? onToggleSelect() : onOpen())}
        aria-current={selected}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-1.5 py-2.5 pl-10 pr-3 text-left text-sm transition-colors",
          selected
            ? "bg-accent text-accent-foreground"
            : "bg-card hover:bg-muted/50",
        )}
      >
        <span className="min-w-0 truncate pr-6 font-medium">
          {post.title || t("sandbox.postBoard.untitled")}
        </span>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[post.status]} className="shrink-0">
            {t(POST_STATUS_LABEL[post.status])}
          </Badge>
          {hasIssues && (
            <span className="inline-flex items-center gap-1 text-xs text-warning">
              <AlertCircle size={12} />
              {post.missing.length}
            </span>
          )}
          {hasDate && (
            <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
              <CalendarDate size={12} />
              {(post.scheduledDatetime || post.date || "").slice(0, 10)}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

function PostCard({
  post,
  payload,
  moving,
  onOpen,
  onArchive,
}: {
  post: PostMeta;
  payload: Record<string, unknown>;
  /** A move for this post is in flight — freeze it so a second one can't race. */
  moving: boolean;
  onOpen: () => void;
  /** Omitted for a post that is already archived — there is nothing to archive. */
  onArchive?: () => void;
}) {
  const t = useT();
  const draggable = post.status !== "generating" && !moving;
  const plan = planningMeta(payload);

  return (
    <div
      className={cn(
        "group/card relative rounded-lg border bg-card shadow-sm transition-colors hover:border-primary/40",
        !draggable && "opacity-80",
      )}
    >
      {onArchive && (
        <ArchiveButton
          onArchive={onArchive}
          disabled={moving}
          className="top-2"
        />
      )}
      <button
        type="button"
        draggable={draggable}
        onDragStart={(e) => e.dataTransfer.setData(DRAG_KEY, post.key)}
        onClick={onOpen}
        className={cn(
          "block w-full p-3 text-left",
          draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        )}
      >
        <p className="line-clamp-2 pr-6 text-sm font-medium">
          {post.title || t("sandbox.postBoard.untitled")}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {post.status === "draft" && (
            <>
              {plan.pillarTitle && (
                <Badge variant="secondary" className="max-w-full truncate">
                  {plan.pillarTitle}
                </Badge>
              )}
              {plan.format?.name && (
                <Badge variant="outline" className="max-w-full truncate">
                  {plan.format.name}
                </Badge>
              )}
            </>
          )}
          {post.status === "generating" && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loading02 size={12} className="animate-spin" />
              {t("sandbox.postBoard.generatingLabel")}
            </span>
          )}
          {post.status === "awaiting_review" &&
            (post.missing.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <AlertCircle size={12} />
                {t("sandbox.postBoard.nIssues", {
                  count: String(post.missing.length),
                })}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <CheckCircle size={12} />
                {t("sandbox.postBoard.readyToSchedule")}
              </span>
            ))}
          {(post.status === "scheduled" || post.status === "published") && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CalendarDate size={12} />
              {(post.scheduledDatetime || post.date || "").slice(0, 10)}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}

/**
 * The ideas tray: what the blog could write, parked beside what it is writing.
 *
 * Deliberately not a lane. An idea has no status and never moves through the
 * lifecycle — writing from it produces a post, and the idea stays put, because
 * one idea is worth several posts in several formats.
 */
function IdeaTray({
  ideas,
  collapsed,
  pillarTitleOf,
  onToggleCollapsed,
  onGenerate,
  onDelete,
}: {
  ideas: IdeaEntry[];
  collapsed: boolean;
  pillarTitleOf: (key?: string) => string | undefined;
  onToggleCollapsed: () => void;
  onGenerate: (idea: IdeaEntry) => void;
  onDelete: (idea: IdeaEntry) => void;
}) {
  const t = useT();
  const label = t("sandbox.postBoard.ideasTray");
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label={t("sandbox.postBoard.expandLane", { lane: label })}
        aria-expanded={false}
        className="flex w-11 shrink-0 cursor-pointer flex-col items-center gap-2 py-2.5 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight size={14} className="shrink-0" />
        <span className="text-xs tabular-nums">{ideas.length}</span>
        <span className="[writing-mode:vertical-rl] text-sm font-medium">
          {label}
        </span>
      </button>
    );
  }
  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={t("sandbox.postBoard.collapseLane", { lane: label })}
          aria-expanded
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left hover:text-muted-foreground"
        >
          <ChevronDown size={14} className="shrink-0" />
          <span className="truncate">{label}</span>
        </button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {ideas.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-2 pr-1">
        {ideas.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            {t("sandbox.postBoard.ideasEmpty")}
          </p>
        ) : (
          ideas.map((idea) => {
            const pillar = pillarTitleOf(idea.pillarKey);
            return (
              <div
                key={idea.key}
                className="group/card relative rounded-lg border border-dashed bg-card shadow-sm transition-colors hover:border-primary/40"
              >
                <ArchiveButton
                  label={t("sandbox.postBoard.deleteIdea")}
                  onArchive={() => onDelete(idea)}
                  className="top-2"
                />
                <div className="p-3">
                  <p className="line-clamp-2 pr-6 text-sm font-medium">
                    {idea.title || t("sandbox.postBoard.untitledIdea")}
                  </p>
                  {idea.body && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {idea.body}
                    </p>
                  )}
                  {pillar && (
                    <Badge
                      variant="secondary"
                      className="mt-2 max-w-full truncate"
                    >
                      {pillar}
                    </Badge>
                  )}
                </div>
                <div className="border-t px-3 py-2">
                  {/* The other door into the same generation dialog. */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled
                    className="h-7 w-full justify-start px-1.5 text-xs"
                    onClick={() => onGenerate(idea)}
                  >
                    <Stars02 size={13} />
                    {t("sandbox.postBoard.writeFromIdea")}
                    <Badge variant="secondary" className="ml-auto">
                      {t("common.soon")}
                    </Badge>
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Delete affordance for a post. Deleting is a soft delete — the post moves to
 * the Archived lane, so nothing is lost and no confirmation is warranted.
 */
function ArchiveButton({
  label,
  onArchive,
  disabled,
  className,
}: {
  label?: string;
  onArchive: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useT();
  const text = label ?? t("sandbox.postBoard.delete");
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={text}
      title={text}
      onClick={(e) => {
        e.stopPropagation();
        onArchive();
      }}
      className={cn(
        "absolute right-2 z-10 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover/card:opacity-100 group-hover/row:opacity-100",
        className,
      )}
    >
      <Trash01 size={13} />
    </button>
  );
}

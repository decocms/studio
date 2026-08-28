/**
 * The Posts area: one workspace with two views of the same lifecycle — a Kanban
 * Board (lanes by status, drag to advance) and a grouped List (by status by
 * default, switchable to format or pillar). Opening a post swaps to the editor;
 * the caller renders that with a Back button. Statuses are the blog app's own
 * `PostStatus` vocabulary; deleting a post is a soft delete into Archived.
 */
import { type ReactNode, Suspense, useState } from "react";
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
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useLocalStorage } from "@/hooks/use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
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
} from "./blog-data";
import { PickList, str } from "./blocks/primitives";

export type PostsView = "board" | "list";
export type PostsGroupBy = "status" | "format" | "pillar";

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

/** Drag payload key — the dragged post's block key. */
const DRAG_KEY = "application/x-post-key";

export function PostsWorkspace({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  view,
  groupBy,
  selectedKey,
  onViewChange,
  onGroupByChange,
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
  groupBy: PostsGroupBy;
  /** The open post — a highlighted row in list mode, an open drawer in board mode. */
  selectedKey?: string | null;
  onViewChange: (view: PostsView) => void;
  onGroupByChange: (groupBy: PostsGroupBy) => void;
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
          {view === "list" && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("sandbox.postBoard.groupBy")}</span>
              <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
                {(
                  [
                    ["status", "sandbox.postBoard.groupStatus"],
                    ["format", "sandbox.postBoard.groupFormat"],
                    ["pillar", "sandbox.postBoard.groupPillar"],
                  ] as const satisfies ReadonlyArray<
                    [PostsGroupBy, TranslationKey]
                  >
                ).map(([value, label]) => (
                  <ToggleButton
                    key={value}
                    active={groupBy === value}
                    onClick={() => onGroupByChange(value)}
                    label={t(label)}
                  />
                ))}
              </div>
            </div>
          )}
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isGenerating || !hasAi}
                title={
                  hasAi
                    ? t("sandbox.postBoard.generateIdeasHint")
                    : t("sandbox.autonomous.noAiProvider")
                }
              >
                <Stars02 size={14} />
                {t("sandbox.postBoard.generateIdeas")}
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
              <DropdownMenuItem
                disabled={!hasAi}
                onClick={() => {
                  setGenerateSeed(undefined);
                  setGenerateOpen(true);
                }}
              >
                <Stars02 size={14} />
                <div className="flex flex-col">
                  <span>{t("sandbox.postBoard.newPostGenerate")}</span>
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
            hasAi={hasAi}
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
          <div className="w-80 shrink-0 overflow-y-auto border-r">
            <PostList
              posts={posts}
              groupBy={groupBy}
              payloadOf={payloadOf}
              selectedKey={detailKey}
              onOpen={onOpen}
              isMoving={move.isMoving}
              onArchive={(post) => void archivePost(post)}
            />
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

/** A post's group key + display label under the current grouping. */
function groupOf(
  post: PostMeta,
  payload: Record<string, unknown>,
  groupBy: PostsGroupBy,
  t: ReturnType<typeof useT>,
): { key: string; label: string } {
  if (groupBy === "status") {
    return { key: post.status, label: t(POST_STATUS_LABEL[post.status]) };
  }
  const plan = planningMeta(payload);
  if (groupBy === "format") {
    const name = plan.format?.name?.trim();
    return name
      ? { key: name, label: name }
      : { key: "", label: t("sandbox.postBoard.noFormat") };
  }
  const name = plan.pillarTitle?.trim();
  return name
    ? { key: name, label: name }
    : { key: "", label: t("sandbox.postBoard.noPillar") };
}

function PostList({
  posts,
  groupBy,
  payloadOf,
  selectedKey,
  onOpen,
  isMoving,
  onArchive,
}: {
  posts: PostMeta[];
  groupBy: PostsGroupBy;
  payloadOf: (key: string) => Record<string, unknown>;
  selectedKey?: string | null;
  onOpen: (key: string) => void;
  isMoving: (key: string) => boolean;
  onArchive: (post: PostMeta) => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Preserve the lifecycle order when grouping by status; otherwise sort labels.
  const groups: Array<{ key: string; label: string; posts: PostMeta[] }> = [];
  const index = new Map<string, number>();
  const ordered =
    groupBy === "status"
      ? [...posts].sort(
          (a, b) =>
            POST_STATUSES.indexOf(a.status) - POST_STATUSES.indexOf(b.status),
        )
      : [...posts].sort((a, b) => a.title.localeCompare(b.title));
  for (const post of ordered) {
    const g = groupOf(post, payloadOf(post.key), groupBy, t);
    const at = index.get(g.key);
    if (at === undefined) {
      index.set(g.key, groups.length);
      groups.push({ key: g.key, label: g.label, posts: [post] });
    } else {
      groups[at]?.posts.push(post);
    }
  }

  return (
    <div className="space-y-4 px-3 py-3">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        return (
          <div key={group.key}>
            <button
              type="button"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })
              }
              className="mb-1.5 flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground"
            >
              {isCollapsed ? (
                <ChevronRight size={13} className="shrink-0" />
              ) : (
                <ChevronDown size={13} className="shrink-0" />
              )}
              <span className="truncate">{group.label}</span>
              <span className="tabular-nums">· {group.posts.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="divide-y overflow-hidden rounded-lg border">
                {group.posts.map((post) => (
                  <PostRow
                    key={post.key}
                    post={post}
                    selected={post.key === selectedKey}
                    showStatus={groupBy !== "status"}
                    moving={isMoving(post.key)}
                    onOpen={() => onOpen(post.key)}
                    onArchive={
                      post.status === "archived"
                        ? undefined
                        : () => onArchive(post)
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PostRow({
  post,
  selected,
  showStatus,
  moving,
  onOpen,
  onArchive,
}: {
  post: PostMeta;
  selected: boolean;
  /** Show the status badge — redundant when the list is already grouped by status. */
  showStatus: boolean;
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
  const showMeta = showStatus || hasIssues || hasDate;
  return (
    <li className="group/row relative">
      {onArchive && (
        <ArchiveButton
          onArchive={onArchive}
          disabled={moving}
          className="top-2.5"
        />
      )}
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-1.5 px-3 py-2.5 text-left text-sm transition-colors",
          selected
            ? "bg-accent text-accent-foreground"
            : "bg-card hover:bg-muted/50",
        )}
      >
        <span className="min-w-0 truncate pr-6 font-medium">
          {post.title || t("sandbox.postBoard.untitled")}
        </span>
        {showMeta && (
          <div className="flex items-center gap-2">
            {showStatus && (
              <Badge variant={STATUS_VARIANT[post.status]} className="shrink-0">
                {t(POST_STATUS_LABEL[post.status])}
              </Badge>
            )}
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
        )}
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
  hasAi,
  collapsed,
  pillarTitleOf,
  onToggleCollapsed,
  onGenerate,
  onDelete,
}: {
  ideas: IdeaEntry[];
  hasAi: boolean;
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!hasAi}
                    className="h-7 w-full justify-start px-1.5 text-xs"
                    onClick={() => onGenerate(idea)}
                  >
                    <Stars02 size={13} />
                    {t("sandbox.postBoard.writeFromIdea")}
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

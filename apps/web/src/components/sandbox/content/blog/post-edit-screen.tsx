import { type CSSProperties, lazy, Suspense } from "react";
import { Columns03, Pilcrow01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Page } from "@/components/page";
import { useElementWidth } from "@/hooks/use-element-width";
import { useT } from "@/i18n/use-t.ts";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import { usePreviewLinkDraftPointer } from "@/components/sections-editor/use-fast-preview-draft-url";
import { getBlogPayload } from "./blog-data";
import { postIdOfKey } from "./blog-post-id";
import type { BlogPostView } from "./blog-search-params";
import { usePostStatusMove } from "./use-post-status-move";
import { PostPreviewPane } from "./post-preview-pane";
import {
  POST_EDITOR_SHARE,
  resolvePostSplitLayout,
  showsPostPane,
  togglePostPane,
  type PostSplitLayout,
} from "./post-split-layout";
import {
  EDITOR_WIDTH_VAR,
  type PostSplitResize,
  usePostSplitResize,
} from "./use-post-split-resize";
import { str } from "./blocks/primitives";

const PostEditor = lazy(() =>
  import("./post-editor").then((m) => ({ default: m.PostEditor })),
);

/**
 * One post's editing screen: the editor and the site's render of it, side by
 * side where there is room for both.
 *
 * The screen owns the arrangement and the preview's reload signal; the editor
 * below it is unchanged and still owns its own autosave.
 */
export function PostEditScreen({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  decofile,
  meta,
  previewBaseUrl,
  fastPreviewActive,
  view,
  onViewChange,
  onOpenBlog,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  previewBaseUrl: string | null | undefined;
  /** The preview renders Fast Preview's draft (`BlogWorkspaceContext`). */
  fastPreviewActive: boolean;
  view: BlogPostView | undefined;
  onViewChange: (next: BlogPostView | undefined) => void;
  /** Returning to the browser — the Blog crumb's action. */
  onOpenBlog: () => void;
}) {
  const t = useT();
  const [width, widthRef] = useElementWidth();
  /**
   * A status change across the planning/live boundary RENAMES the block. The
   * URL names the post id, which both forms share, so the screen re-resolves
   * the key on the next render and stays on the post.
   */
  const move = usePostStatusMove({ orgSlug, virtualMcpId, branch, decofile });
  // The same `?__draft=` a category's "Preview" link sends.
  const draftPointer = usePreviewLinkDraftPointer({
    orgSlug,
    virtualMcpId,
    branch,
  });

  const block = decofile[blockKey] as Record<string, unknown> | undefined;
  const post = getBlogPayload(block, "posts");

  const layout = resolvePostSplitLayout({ width, view });
  const split = usePostSplitResize();
  const showsEditor = showsPostPane(layout, "edit");
  /** Hidden, not unmounted, whenever it is not showing — including before the
   *  first measurement, so the screen paints as the editor rather than as an
   *  empty frame. */
  const showsPreview = showsPostPane(layout, "preview");
  /** Both panes side by side, at the dragged width; a pane alone takes it all. */
  const splitShown = layout.kind === "side-by-side" && layout.panes === "both";
  const title = str(post.title);

  const editorPane = (
    <PostEditorPane
      orgSlug={orgSlug}
      virtualMcpId={virtualMcpId}
      branch={branch}
      blockKey={blockKey}
      decofile={decofile}
      meta={meta}
      previewBaseUrl={previewBaseUrl}
      move={move}
      onDeleted={onOpenBlog}
    />
  );

  return (
    <div ref={widthRef} className="flex h-full min-h-0 flex-col">
      <Page.Breadcrumbs
        after="page"
        parent={{ onSelect: onOpenBlog }}
        items={[
          {
            key: `post:${postIdOfKey(blockKey)}`,
            label: title || t("sandbox.postBoard.untitled"),
          },
        ]}
      />
      {layout.kind !== "pending" && (
        <div className="flex h-10 shrink-0 items-center justify-end border-b px-2">
          <ViewToggle layout={layout} onViewChange={onViewChange} />
        </div>
      )}
      {/* ONE tree for every arrangement, with widths in classNames and the
          split's width in a CSS variable. Both panes stay mounted whatever
          the layout, so toggling — and crossing the breakpoint as the chat
          panel is resized — never reloads the preview. An imperative
          `resize()` on a resizable group (the pattern the Site Editor uses)
          could not do the second half: it only fires from a click, and
          `useEffect` is banned here, so a width change with no click would
          leave the panes where the last click put them. */}
      <div
        ref={split.containerRef}
        className="flex min-h-0 flex-1"
        style={{ [EDITOR_WIDTH_VAR]: `${split.share}%` } as CSSProperties}
      >
        <div
          className={cn(
            "min-w-0",
            !showsEditor && "hidden",
            splitShown ? "shrink-0" : "flex-1",
          )}
          style={splitShown ? { width: `var(${EDITOR_WIDTH_VAR})` } : undefined}
        >
          {editorPane}
        </div>
        {splitShown && <PostSplitHandle split={split} />}
        <div className={cn("min-w-0 flex-1", !showsPreview && "hidden")}>
          <PostPreviewPane
            orgSlug={orgSlug}
            virtualMcpId={virtualMcpId}
            decofile={decofile}
            post={post}
            blockKey={blockKey}
            previewBaseUrl={previewBaseUrl}
            meta={meta}
            fastPreviewActive={fastPreviewActive}
            draftPointer={draftPointer}
            visible={showsPreview}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The panes' controls. Wide, each pane has a toggle and both may be on: the
 * pane left alone takes the width, and can't be hidden itself. Narrow, the
 * same two pick the one pane that fits.
 */
function ViewToggle({
  layout,
  onViewChange,
}: {
  layout: PostSplitLayout;
  onViewChange: (next: BlogPostView | undefined) => void;
}) {
  const t = useT();
  if (layout.kind === "pending") return null;
  const panes = [
    {
      pane: "edit",
      label: t("sandbox.postEditScreen.edit"),
      icon: <Pilcrow01 size={14} />,
    },
    {
      pane: "preview",
      label: t("sandbox.postEditScreen.preview"),
      icon: <Columns03 size={14} />,
    },
  ] as const;
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {panes.map(({ pane, label, icon }) => {
        const pressed = showsPostPane(layout, pane);
        if (layout.kind === "one-at-a-time") {
          return (
            <PaneToggle
              key={pane}
              pressed={pressed}
              label={label}
              icon={icon}
              /** Selecting the open pane leaves it open, per the shared tab rule. */
              onClick={pressed ? undefined : () => onViewChange(pane)}
            />
          );
        }
        const next = togglePostPane(layout.panes, pane);
        return (
          <PaneToggle
            key={pane}
            pressed={pressed}
            locked={next === null}
            label={label}
            icon={icon}
            onClick={next === null ? undefined : () => onViewChange(next)}
          />
        );
      })}
    </div>
  );
}

function PaneToggle({
  pressed,
  locked = false,
  label,
  icon,
  onClick,
}: {
  pressed: boolean;
  /** The pane showing alone: it stays on. Not `disabled`, whose dimming
   *  would make the one pane on screen look like the one that's off. */
  locked?: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: (() => void) | undefined;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={pressed}
      aria-disabled={locked || undefined}
      className={cn(
        "h-7 px-2",
        pressed && "bg-background shadow-sm",
        locked && "cursor-default",
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  );
}

/** The split's divider. Its line is the preview's own left border; this is a
 *  wider grab area over it, lit on hover, drag and focus like the sidebar's. */
function PostSplitHandle({ split }: { split: PostSplitResize }) {
  const t = useT();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sandbox.postEditScreen.resizeSplit")}
      aria-valuenow={Math.round(split.share)}
      aria-valuemin={POST_EDITOR_SHARE.min}
      aria-valuemax={POST_EDITOR_SHARE.max}
      title={t("sandbox.postEditScreen.resizeSplitHint")}
      tabIndex={0}
      onPointerDown={split.onPointerDown}
      onKeyDown={split.onKeyDown}
      onDoubleClick={split.reset}
      className="group/resize relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover/resize:bg-ring group-active/resize:bg-ring group-focus-visible/resize:bg-ring" />
    </div>
  );
}

function PostEditorPane({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  decofile,
  meta,
  previewBaseUrl,
  move,
  onDeleted,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  previewBaseUrl: string | null | undefined;
  move: ReturnType<typeof usePostStatusMove>;
  onDeleted: () => void;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      }
    >
      <PostEditor
        key={`post:${postIdOfKey(blockKey)}`}
        orgSlug={orgSlug}
        virtualMcpId={virtualMcpId}
        branch={branch}
        blockKey={blockKey}
        block={decofile[blockKey] as Record<string, unknown>}
        decofile={decofile}
        meta={meta}
        previewBaseUrl={previewBaseUrl}
        move={move}
        onDeleted={onDeleted}
      />
    </Suspense>
  );
}

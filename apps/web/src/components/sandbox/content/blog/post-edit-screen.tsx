import { lazy, Suspense } from "react";
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
  nextPostView,
  resolvePostSplitLayout,
  type PostSplitLayout,
} from "./post-split-layout";
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
  const showsEditor =
    layout.kind !== "one-at-a-time" || layout.showing === "edit";
  /** Hidden, not unmounted, whenever it is not showing — including before the
   *  first measurement, so the screen paints as the editor rather than as an
   *  empty frame. */
  const showsPreview =
    layout.kind === "side-by-side"
      ? !layout.previewCollapsed
      : layout.kind === "one-at-a-time" && layout.showing === "preview";
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
          <ViewToggle
            layout={layout}
            onToggle={() => onViewChange(nextPostView(layout))}
          />
        </div>
      )}
      {/* ONE tree for all three arrangements, with widths in classNames.
          Both panes stay mounted whatever the layout, so toggling — and
          crossing the breakpoint as the chat panel is resized — never reloads
          the preview. An imperative `resize()` on a resizable group (the
          pattern the Site Editor uses) could not do the second half: it only
          fires from a click, and `useEffect` is banned here, so a width change
          with no click would leave the panes where the last click put them. */}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "min-w-0",
            !showsEditor && "hidden",
            layout.kind === "side-by-side" ? "w-[55%]" : "flex-1",
          )}
        >
          {editorPane}
        </div>
        <div className={cn("min-w-0 flex-1", !showsPreview && "hidden")}>
          <PostPreviewPane
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

function ViewToggle({
  layout,
  onToggle,
}: {
  layout: PostSplitLayout;
  onToggle: () => void;
}) {
  const t = useT();
  if (layout.kind === "pending") return null;
  if (layout.kind === "side-by-side") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={!layout.previewCollapsed}
        onClick={onToggle}
      >
        <Columns03 size={14} />
        {t("sandbox.postEditScreen.preview")}
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      <ToggleOption
        active={layout.showing === "edit"}
        label={t("sandbox.postEditScreen.edit")}
        icon={<Pilcrow01 size={14} />}
        onClick={onToggle}
      />
      <ToggleOption
        active={layout.showing === "preview"}
        label={t("sandbox.postEditScreen.preview")}
        icon={<Columns03 size={14} />}
        onClick={onToggle}
      />
    </div>
  );
}

function ToggleOption({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={active}
      className={cn("h-7 px-2", active && "bg-background shadow-sm")}
      /** Selecting the open pane leaves it open, per the shared tab rule. */
      onClick={active ? undefined : onClick}
    >
      {icon}
      {label}
    </Button>
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

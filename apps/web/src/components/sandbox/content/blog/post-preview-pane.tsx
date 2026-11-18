import { useRef, useState } from "react";
import {
  LinkExternal01,
  Monitor01,
  Phone01,
  RefreshCw01,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useElementSize } from "@/hooks/use-element-size.ts";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import type { PreviewDeviceSize } from "@/components/sandbox/preview/device-hint.ts";
import {
  reloadIframeOrFallback,
  SitePreviewFrame,
} from "@/components/sandbox/preview/site-preview-frame.tsx";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { useContentSyncBusy } from "@/components/sections-editor/content-sync";
import { useSandboxReloadHandler } from "@/components/sandbox/hooks/use-sandbox-events";
import { buildBlogPostPreviewUrl, findBlogPageSlug } from "./blog-preview-url";
import { isPlanningPostKey } from "./blog-post-id";

type PreviewDevice = Extract<PreviewDeviceSize, "desktop" | "mobile">;

/**
 * Why the post cannot be previewed, or `null` when it can.
 *
 * Exported for its own test: the reasons are not interchangeable, and picking
 * the wrong one tells the writer to fix something that is already fine.
 */
export type PostPreviewBlock =
  /** No site to render yet — transient: the pod is booting, or Fast Preview's
   *  draft pointer is on its way. */
  | "no-origin"
  /** The site has no blog post route, so nothing can render a post. */
  | "no-route"
  /** The route needs a slug (and sometimes a category) this post lacks. */
  | "missing-params";

export function resolvePostPreviewBlock(input: {
  previewBaseUrl: string | null | undefined;
  hasPostRoute: boolean;
  url: string | null;
  /** Fast Preview's draft render, whose `?__draft=` pointer hasn't arrived:
   *  without it the frame would load the published page. */
  awaitingDraft: boolean;
}): PostPreviewBlock | null {
  if (!input.previewBaseUrl || input.awaitingDraft) return "no-origin";
  if (!input.hasPostRoute) return "no-route";
  if (!input.url) return "missing-params";
  return null;
}

/** Spelled out rather than built from the reason, so every key is greppable. */
const BLOCK_TITLE: Record<PostPreviewBlock, TranslationKey> = {
  "no-origin": "sandbox.postPreview.noOrigin",
  "no-route": "sandbox.postPreview.noRoute",
  "missing-params": "sandbox.postPreview.missingParams",
};

const BLOCK_HINT: Record<PostPreviewBlock, TranslationKey> = {
  "no-origin": "sandbox.postPreview.noOriginHint",
  "no-route": "sandbox.postPreview.noRouteHint",
  "missing-params": "sandbox.postPreview.missingParamsHint",
};

/**
 * The post as the site renders it, beside the editor. A post still in
 * planning (a block with no `__resolveType`) is asked for with the blog app's
 * `?draft=true` ({@link buildBlogPostPreviewUrl}).
 *
 * Reload policy lives in {@link SitePreviewFrame}: a sandbox session's saves
 * are reloaded by the dev server's own HMR, and Fast Preview moves the
 * `?__draft=` version so the URL changes on its own. This pane forces a reload
 * only where nothing else would: when the sandbox asks for one (a Deno dev
 * server, which doesn't reload on content changes, or a moved or restarted
 * one), and from the refresh button. Doing it on every save was what killed
 * the dev server.
 */
export function PostPreviewPane({
  orgSlug,
  virtualMcpId,
  decofile,
  post,
  blockKey,
  previewBaseUrl,
  meta,
  fastPreviewActive,
  draftPointer,
  visible,
}: {
  /** The project, whose content saves the frame shows (content-sync.ts). */
  orgSlug: string;
  virtualMcpId: string;
  decofile: Record<string, unknown>;
  post: Record<string, unknown>;
  blockKey: string;
  previewBaseUrl: string | null | undefined;
  /** The site's schema, for a next-major site's page types. */
  meta: LiveMeta;
  /** The frame renders Fast Preview's draft, through `draftPointer`. */
  fastPreviewActive: boolean;
  draftPointer: string | null;
  /** Showing on screen. The pane stays mounted when it is not, so toggling
   *  back is instant — but it must not start loading the site before anyone
   *  has asked to see it. */
  visible: boolean;
}) {
  const t = useT();
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [canvas, canvasRef] = useElementSize();

  /**
   * Latches on first sight: before that the frame is never created, so an
   * editor-only session never renders the site at all. Loading it costs a full
   * server render, which is not free for the dev server answering it.
   */
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);

  const url = buildBlogPostPreviewUrl({
    decofile,
    post,
    previewBaseUrl,
    draftPointer: fastPreviewActive ? draftPointer : null,
    meta,
    planning: isPlanningPostKey(blockKey),
  });
  const blocked = resolvePostPreviewBlock({
    previewBaseUrl,
    hasPostRoute: !!findBlogPageSlug(decofile, meta),
    url,
    awaitingDraft: fastPreviewActive && !draftPointer,
  });

  /** Every Blog save runs through the project's content-sync store, so this is
   *  the editor's write on its way to the page. */
  const changePending = useContentSyncBusy(orgSlug, virtualMcpId);
  /** Reloads this pane asked for: the frame shows the bar until each loads. */
  const [reloads, setReloads] = useState(0);
  const reload = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    // To the newest URL: a Deno dev server's reload comes once it has the
    // saved content, which a new slug's page needs, whether or not the frame
    // went to that page yet.
    reloadIframeOrFallback(iframe, url);
    setReloads((n) => n + 1);
  };
  // Inert in Fast Preview, which mounts no sandbox to ask.
  useSandboxReloadHandler(reload);

  return (
    <div className="flex h-full min-w-0 flex-col border-l bg-muted/30">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-2">
        <div className="flex items-center gap-0.5">
          <DeviceButton
            active={device === "desktop"}
            label={t("sandbox.postPreview.desktop")}
            onClick={() => setDevice("desktop")}
          >
            <Monitor01 size={16} />
          </DeviceButton>
          <DeviceButton
            active={device === "mobile"}
            label={t("sandbox.postPreview.mobile")}
            onClick={() => setDevice("mobile")}
          >
            <Phone01 size={16} />
          </DeviceButton>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!!blocked}
            aria-label={t("sandbox.postPreview.refresh")}
            title={t("sandbox.postPreview.refresh")}
            onClick={reload}
          >
            <RefreshCw01 size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // A blocked preview has nothing to open: until its draft pointer
            // arrives, Fast Preview's URL shows the published page.
            disabled={!url || !!blocked}
            aria-label={t("sandbox.postPreview.openInNewTab")}
            title={t("sandbox.postPreview.openInNewTab")}
            onClick={() => {
              if (url && !blocked) {
                window.open(url, "_blank", "noopener,noreferrer");
              }
            }}
          >
            <LinkExternal01 size={16} />
          </Button>
        </div>
      </div>
      <div
        ref={canvasRef}
        className="relative flex min-h-0 flex-1 justify-center overflow-clip bg-muted/30"
      >
        {blocked || !url ? (
          <EmptyState
            className="h-full"
            title={t(BLOCK_TITLE[blocked ?? "missing-params"])}
            description={t(BLOCK_HINT[blocked ?? "missing-params"])}
          />
        ) : !mounted ? null : (
          <SitePreviewFrame
            iframeRef={iframeRef}
            /** The post page is one route on one origin; only the origin
             *  moving should drop the document. */
            iframeBase={previewBaseUrl ?? null}
            src={url}
            device={device}
            canvas={canvas}
            title={t("sandbox.postPreview.frameTitle")}
            /** The sandbox dev server can come back after a stall; Fast
             *  Preview's frame navigates cross-origin instead. Unblocked, a
             *  Fast Preview frame always has its draft pointer. */
            recoveryActive={!fastPreviewActive}
            draftUrl={fastPreviewActive ? url : null}
            holdNavigation={fastPreviewActive}
            changePending={changePending}
            expectLoad={reloads}
          />
        )}
      </div>
    </div>
  );
}

function DeviceButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(active && "bg-accent text-accent-foreground")}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

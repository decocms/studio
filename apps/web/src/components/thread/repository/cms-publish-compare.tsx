/**
 * The publish dialog's review pane: the selected change rendered by the live
 * site and its {@link CompareDraft} — as published, and with the changes —
 * so content editors compare pages instead of reading block JSON. The raw
 * file diff stays one tab away for changes that have no page to render.
 */

import { cn } from "@decocms/ui/lib/utils.ts";
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Tabs, TabsList, TabsTrigger } from "@decocms/ui/components/tabs.tsx";
import {
  LinkExternal01,
  Eye,
  Monitor01,
  Phone01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import {
  createContext,
  use,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useT } from "@/i18n/use-t.ts";
import { type ElementSize, useElementSize } from "@/hooks/use-element-size.ts";
import {
  DRAFT_OFF,
  withDraftPointer,
} from "@/components/sections-editor/section-preview-url.ts";
import { extractPathParams } from "@/components/sections-editor/page-path-utils.ts";
import type { LastPreviewPage } from "@/components/sandbox/preview/last-preview-page.ts";
import { withDeviceHint } from "@/components/sandbox/preview/device-hint.ts";
import { GitDiffList } from "./git-diff-list.tsx";
import { PublishGhost } from "./cms-publish-frame.tsx";
import {
  blockComparePath,
  canRenderCompare,
  compareDraftUrl,
  comparePlaceholder,
  compareUrl,
  initialComparePath,
  isComparePathEditable,
  isolatedSectionKey,
  type CompareDraft,
} from "./cms-publish-compare-path.ts";
import { blockFileName } from "@decocms/blocks/protocol";
import type { PublishChange } from "./publish-change-summary.ts";
import type { GitDiffResult } from "./sandbox-git-api.ts";

/**
 * Whether the review pane offers the Code tab. The Experiments and Calendar
 * views turn it off (PO decision): their publish panel shows pages only, and
 * a change with no page to show says so instead. The site editor keeps it.
 */
export const PublishCodeTab = createContext(true);

const COMPARE_VIEWS = ["split", "before", "after", "code"] as const;
type CompareView = (typeof COMPARE_VIEWS)[number];

function isCompareView(value: string): value is CompareView {
  return (COMPARE_VIEWS as readonly string[]).includes(value);
}
type CompareDevice = "desktop" | "mobile";

/** Logical render widths — the frames scale down to fit, never reflow. */
const DEVICE_WIDTH: Record<CompareDevice, number> = {
  desktop: 1280,
  mobile: 412,
};

interface PublishCompareProps {
  change: PublishChange;
  /** The whole publish diff; the Code tab slices out this change's files. */
  diff: GitDiffResult | null;
  bodyPending: boolean;
  /** Origin of the live site the draft renders against. */
  previewServerUrl: string | null;
  /** Where the changes render; null until Fast Preview stashes a grant. */
  draft: CompareDraft | null;
  lastPage: LastPreviewPage | null;
  /**
   * Set on a Blocks v8 site, with its current blocks once the editor has
   * them: a saved section compares on a page that shows it, since v8 has no
   * isolated-section route. Absent on v7.
   */
  v8?: { blocks: Record<string, unknown> | null };
  /**
   * Called once the pages this pane shows have loaded (or it has none), so
   * the panel can keep the previous pane on screen until then. v8 only.
   */
  onReady?: () => void;
}

/**
 * A v8 change's Code tab: its two sides (`changes.get`, secrets masked) as
 * JSON, under the entry's file name. Empty until the sides are loaded; a
 * side that exists but can't be read says so instead.
 */
function entryDiff(change: PublishChange, unreadable: string): GitDiffResult {
  const side = (
    json: Record<string, unknown> | null,
    which: "before" | "after",
  ) =>
    change.unreadable?.includes(which)
      ? unreadable
      : json
        ? `${JSON.stringify(json, null, 2)}\n`
        : null;
  const from = change.status === "new" ? null : side(change.fromJson, "before");
  const to = change.status === "removed" ? null : side(change.toJson, "after");
  if (from === null && to === null) return { diffs: {} };
  // A new entry's `toJson` stands in from the current blocks before its
  // sides load: only a loaded edit or removal has a `from`.
  if (change.status === "edited" && (from === null || to === null)) {
    return { diffs: {} };
  }
  return {
    diffs: { [blockFileName(change.entry!.name)]: { from, to } },
  };
}

export function PublishCompare({
  change,
  diff,
  bodyPending,
  previewServerUrl,
  draft,
  lastPage,
  v8,
  onReady,
}: PublishCompareProps) {
  const t = useT();
  const showsCode = use(PublishCodeTab);
  const savedSection = isolatedSectionKey(change);
  /** Renders on its own (v7); on v8 it shows on a page, like any change. */
  const sectionKey = v8 ? null : savedSection;
  /** A v8 saved section: compared on a page that shows it. */
  const v8Section = v8 ? savedSection : null;
  /** That page; null when no page shows the block, undefined until known. */
  const v8SectionPath = v8Section
    ? blockComparePath(v8Section, v8?.blocks, lastPage)
    : undefined;
  /** A v8 saved section no page shows: nothing to preview, only the code. */
  const onNoPage = v8Section !== null && v8SectionPath === null;
  const canRender =
    canRenderCompare(change.kind, previewServerUrl, draft) &&
    (v8Section === null || typeof v8SectionPath === "string");
  /** What the reviewer picked; until then both follow the change, whose path
   *  and kind can still arrive after the pane mounts. */
  const [pickedView, setView] = useState<CompareView | null>(null);
  const view: CompareView = !canRender ? "code" : (pickedView ?? "split");
  const [device, setDevice] = useState<CompareDevice>("desktop");
  const [typedPath, setPath] = useState<string | null>(null);
  const path =
    typedPath ??
    (v8Section ? (v8SectionPath ?? "") : initialComparePath(change, lastPage));
  const pathEditable = isComparePathEditable(change);

  const url = !previewServerUrl
    ? null
    : compareUrl({
        previewServerUrl,
        sectionKey: savedSection,
        path,
        v8: !!v8,
      });
  const beforeUrl = url ? withDraftPointer(url.toString(), DRAFT_OFF) : null;
  const afterUrl = url ? compareDraftUrl(url, draft) : null;

  const rawDiff: GitDiffResult = change.entry
    ? entryDiff(change, t("thread.publishCompare.sideUnreadable"))
    : {
        diffs: Object.fromEntries(
          change.filepaths.flatMap((p) => {
            const entry = diff?.diffs[p];
            return entry ? [[p, entry] as const] : [];
          }),
        ),
      };
  const hasBody = Object.keys(rawDiff.diffs).length > 0;

  const pathHint = (() => {
    if (sectionKey !== null) return null;
    if (v8Section !== null) {
      const shown = path.trim();
      if (!shown) return null;
      return extractPathParams(shown).length > 0
        ? t("thread.publishCompare.dynamicHint", { template: shown })
        : t("thread.publishCompare.blockHint", { path: shown });
    }
    if (change.kind !== "page") return t("thread.publishCompare.globalHint");
    return change.pagePath && extractPathParams(change.pagePath).length > 0
      ? t("thread.publishCompare.dynamicHint", { template: change.pagePath })
      : null;
  })();

  const placeholder = comparePlaceholder(change, !!v8);
  const [loadedFrames, setLoadedFrames] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const frameLoaded = (src: string) =>
    setLoadedFrames((current) =>
      current.has(src) ? current : new Set(current).add(src),
    );
  /** v8: frames keep their last page until the next one loads. */
  const frame = (props: CompareFrameProps) =>
    v8 ? (
      <SmoothCompareFrame {...props} onLoaded={frameLoaded} />
    ) : (
      <CompareFrame {...props} />
    );
  /** The pages this pane waits on: none on the code view or a placeholder. */
  const frameSrcs = canRender
    ? [
        placeholder.before === "new" ? null : beforeUrl,
        placeholder.after === "removed" ? null : afterUrl,
      ].flatMap((u) => (u ? [withDeviceHint(u, device)] : []))
    : [];
  const ready = frameSrcs.every((src) => loadedFrames.has(src));
  /** Attached once the pages are in (or there are none): tells the panel. */
  const readyRef =
    ready && onReady
      ? (node: HTMLDivElement | null) => {
          if (node) onReady();
        }
      : undefined;
  const beforePane =
    placeholder.before === "new" ? (
      <ComparePlaceholder
        icon={<Plus className="size-5 text-brand" />}
        title={t("thread.publishCompare.newTitle")}
        description={t("thread.publishCompare.newDescription")}
      />
    ) : (
      frame({
        url: beforeUrl,
        device,
        title: t("thread.publishCompare.before"),
        missing: t("thread.publishCompare.enterPath"),
      })
    );

  const afterPane =
    placeholder.after === "removed" ? (
      <ComparePlaceholder
        icon={<Trash01 className="size-5 text-destructive" />}
        title={t("thread.publishCompare.removedTitle")}
        description={t("thread.publishCompare.removedDescription")}
      />
    ) : (
      frame({
        url: afterUrl,
        device,
        title: t("thread.publishCompare.after"),
        missing: url
          ? t("thread.publishCompare.draftUnavailable")
          : t("thread.publishCompare.enterPath"),
      })
    );

  return (
    <div
      ref={readyRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/40"
    >
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2.5 max-md:pr-12">
        {canRender || showsCode ? (
          <Tabs
            value={view}
            onValueChange={(next) => {
              if (isCompareView(next)) setView(next);
            }}
          >
            <TabsList className="h-8 w-auto" variant="pill">
              {canRender ? (
                <>
                  <TabsTrigger value="split" className="px-3 text-xs">
                    {t("thread.publishCompare.sideBySide")}
                  </TabsTrigger>
                  <TabsTrigger value="before" className="px-3 text-xs">
                    {t("thread.publishCompare.before")}
                  </TabsTrigger>
                  <TabsTrigger value="after" className="px-3 text-xs">
                    {t("thread.publishCompare.after")}
                  </TabsTrigger>
                </>
              ) : null}
              {showsCode ? (
                <TabsTrigger value="code" className="px-3 text-xs">
                  {t("thread.publishCompare.code")}
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        ) : null}
        {canRender && view !== "code" ? (
          <>
            {sectionKey ? null : pathEditable ? (
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={change.pagePath ?? "/"}
                aria-label={t("thread.publishCompare.pathLabel")}
                className="h-8 w-56 font-mono text-xs"
              />
            ) : (
              <span className="max-w-56 truncate px-1 font-mono text-xs text-muted-foreground">
                {path}
              </span>
            )}
            <div className="flex items-center rounded-lg border p-0.5">
              <DeviceButton
                active={device === "desktop"}
                label={t("thread.publishCompare.desktop")}
                onClick={() => setDevice("desktop")}
              >
                <Monitor01 className="size-3.5" />
              </DeviceButton>
              <DeviceButton
                active={device === "mobile"}
                label={t("thread.publishCompare.mobile")}
                onClick={() => setDevice("mobile")}
              >
                <Phone01 className="size-3.5" />
              </DeviceButton>
            </div>
            {afterUrl ? (
              <a
                href={afterUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <LinkExternal01 className="size-3.5" />
                {t("thread.publishCompare.openDraft")}
              </a>
            ) : null}
          </>
        ) : null}
      </div>
      {pathHint && canRender && view !== "code" ? (
        <p className="border-b bg-background px-4 py-1.5 text-[11px] text-muted-foreground">
          {pathHint}
        </p>
      ) : null}

      {onNoPage && showsCode ? (
        <p className="border-b bg-background px-4 py-1.5 text-[11px] text-muted-foreground">
          {t("thread.publishCompare.notOnAnyPage")}
        </p>
      ) : null}
      {view === "code" && !showsCode ? (
        // Without the Code tab, say why there is no page: still finding it,
        // no site address to show it on yet, or the change is on no page.
        v8Section !== null && v8SectionPath === undefined ? (
          <PublishGhost className="m-4 h-64 rounded" />
        ) : previewServerUrl === null ? (
          <ComparePlaceholder
            icon={<Eye className="size-5 text-muted-foreground" />}
            title={t("thread.publishCompare.previewNotReadyTitle")}
            description={t("thread.publishCompare.draftUnavailable")}
          />
        ) : (
          <ComparePlaceholder
            icon={<Eye className="size-5 text-muted-foreground" />}
            title={t("thread.publishCompare.noPreviewTitle")}
            description={t("thread.publishCompare.noPreviewDescription")}
          />
        )
      ) : null}
      {view === "code" && showsCode ? (
        <div className="min-h-0 flex-1 overflow-y-auto bg-background [scrollbar-width:thin]">
          {hasBody ? (
            <GitDiffList diff={rawDiff} hideFileRows editorHeight="70vh" />
          ) : bodyPending ? (
            <PublishGhost className="m-4 h-64 rounded" />
          ) : (
            <p className="px-4 py-6 text-xs text-muted-foreground">
              {t("thread.publishPopover.detailsUnavailable")}
            </p>
          )}
        </div>
      ) : null}
      {canRender ? (
        // Hidden, never unmounted: switching tabs must not reload the frames.
        <div
          className={cn(
            "flex min-h-0 flex-1 gap-3 p-3",
            view === "code" && "hidden",
          )}
        >
          <ComparePane
            label={t("thread.publishCompare.before")}
            hidden={view === "after"}
          >
            {beforePane}
          </ComparePane>
          <ComparePane
            label={t("thread.publishCompare.after")}
            highlight
            hidden={view === "before"}
          >
            {afterPane}
          </ComparePane>
        </div>
      ) : null}
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
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ComparePane({
  label,
  highlight = false,
  hidden = false,
  children,
}: {
  label: string;
  highlight?: boolean;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col gap-1.5",
        hidden && "hidden",
      )}
    >
      <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        <span
          className={cn(
            "size-1.5 rounded-full bg-muted-foreground/50",
            highlight && "bg-brand",
          )}
        />
        {label}
      </div>
      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background",
          highlight && "border-brand/60",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function ComparePlaceholder({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <div className="mb-1">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/** Where a page of `logicalWidth` sits, scaled to fit a pane of `size`. */
function frameLayout(
  size: ElementSize | null,
  logicalWidth: number,
): CSSProperties {
  // Not measured yet: hidden, never shown at full size (it reads as a zoom).
  if (!size) return { visibility: "hidden", width: logicalWidth };
  const scale = Math.min(size.width / logicalWidth, 1);
  return {
    left: Math.max((size.width - logicalWidth * scale) / 2, 0),
    width: logicalWidth,
    height: size.height / scale,
    transform: `scale(${scale})`,
    transformOrigin: "top left",
  };
}

/**
 * The page at a fixed logical width, scaled to the pane — a faithful miniature
 * of the layout instead of a reflow into whatever breakpoint the half-width
 * pane happens to hit.
 */
interface CompareFrameProps {
  url: string | null;
  device: CompareDevice;
  title: string;
  missing: string;
}

function CompareFrame({ url, device, title, missing }: CompareFrameProps) {
  const [size, ref] = useElementSize();
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  if (!url) {
    return (
      <p className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {missing}
      </p>
    );
  }

  // Width alone keeps the desktop SSR; the hint makes the site render for the device.
  const src = withDeviceHint(url, device);
  const logicalWidth = DEVICE_WIDTH[device];
  const scale = size.width > 0 ? Math.min(size.width / logicalWidth, 1) : 1;
  const offsetX =
    size.width > 0 ? Math.max((size.width - logicalWidth * scale) / 2, 0) : 0;

  // Mounted even while its pane is hidden (size 0): unmounting would reload the page on return.
  return (
    <div ref={ref} className="absolute inset-0">
      {/* Cross-origin site, so `allow-same-origin` keeps ITS origin, not ours. */}
      <iframe
        key={src}
        src={src}
        title={title}
        // oxlint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-scripts allow-same-origin"
        onLoad={() => setLoadedSrc(src)}
        className="absolute top-0 border-0 bg-white"
        style={{
          left: offsetX,
          width: logicalWidth,
          height: size.height > 0 ? size.height / scale : "100%",
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
      {loadedSrc !== src ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60">
          <Spinner className="size-5 motion-reduce:animate-none" />
        </div>
      ) : null}
    </div>
  );
}

/** A frame on screen: its page and the width that page was laid out at. */
interface ShownFrame {
  src: string;
  logicalWidth: number;
}

/**
 * {@link CompareFrame} on a v8 site. A new address (another device, a typed
 * path, a fresh draft pointer) loads in a second frame under the one on
 * screen, which stays until the new page has loaded: no blank in between.
 * A pane hidden for a while (another tab) measures 0: the frame keeps its
 * last size, so it never comes back at full scale.
 */
function SmoothCompareFrame({
  url,
  device,
  title,
  missing,
  onLoaded,
}: CompareFrameProps & { onLoaded?: (src: string) => void }) {
  const [size, ref] = useElementSize();
  const [lastSize, setLastSize] = useState<ElementSize | null>(null);
  const [shown, setShown] = useState<ShownFrame | null>(null);
  const measuredNow = size.width > 0 && size.height > 0;
  if (
    measuredNow &&
    (lastSize?.width !== size.width || lastSize?.height !== size.height)
  ) {
    setLastSize(size);
  }
  const box = measuredNow ? size : lastSize;

  if (!url) {
    return (
      <p className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {missing}
      </p>
    );
  }

  const src = withDeviceHint(url, device);
  const logicalWidth = DEVICE_WIDTH[device];
  const loading = shown?.src !== src;
  // The one on screen first, the loading one after it: a frame already in
  // the list never moves (moving an iframe reloads it).
  const frames: ShownFrame[] = [
    ...(shown && loading ? [shown] : []),
    { src, logicalWidth },
  ];

  return (
    <div ref={ref} className="absolute inset-0">
      {frames.map((frame) => {
        const pending = frame.src === src && loading;
        return (
          // Cross-origin site, so `allow-same-origin` keeps ITS origin, not ours.
          <iframe
            key={frame.src}
            src={frame.src}
            title={title}
            aria-hidden={pending && shown ? true : undefined}
            // oxlint-disable-next-line react/iframe-missing-sandbox
            sandbox="allow-scripts allow-same-origin"
            onLoad={() => {
              if (frame.src !== src) return;
              setShown(frame);
              onLoaded?.(frame.src);
            }}
            className={cn(
              "absolute top-0 border-0 bg-white",
              pending && "pointer-events-none opacity-0",
            )}
            style={frameLayout(box, frame.logicalWidth)}
          />
        );
      })}
      {loading ? (
        shown ? (
          <Spinner className="absolute right-2 top-2 size-4 text-muted-foreground motion-reduce:animate-none" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Spinner className="size-5 motion-reduce:animate-none" />
          </div>
        )
      ) : null}
    </div>
  );
}

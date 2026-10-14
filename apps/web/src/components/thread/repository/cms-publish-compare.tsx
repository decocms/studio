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
  Monitor01,
  Phone01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { useState, type ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import { useElementSize } from "@/hooks/use-element-size.ts";
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
  canRenderCompare,
  compareDraftUrl,
  comparePageUrl,
  compareSectionUrl,
  initialComparePath,
  isComparePathEditable,
  isolatedSectionKey,
  type CompareDraft,
} from "./cms-publish-compare-path.ts";
import type { PublishChange } from "./publish-change-summary.ts";
import type { GitDiffResult } from "./sandbox-git-api.ts";

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
}

export function PublishCompare({
  change,
  diff,
  bodyPending,
  previewServerUrl,
  draft,
  lastPage,
}: PublishCompareProps) {
  const t = useT();
  const canRender = canRenderCompare(change.kind, previewServerUrl, draft);
  /** What the reviewer picked; until then both follow the change, whose path
   *  and kind can still arrive after the pane mounts. */
  const [pickedView, setView] = useState<CompareView | null>(null);
  const view: CompareView = !canRender ? "code" : (pickedView ?? "split");
  const [device, setDevice] = useState<CompareDevice>("desktop");
  const [typedPath, setPath] = useState<string | null>(null);
  const path = typedPath ?? initialComparePath(change, lastPage);

  const sectionKey = isolatedSectionKey(change);
  const pathEditable = isComparePathEditable(change);

  const url = !previewServerUrl
    ? null
    : sectionKey
      ? compareSectionUrl(previewServerUrl, sectionKey)
      : comparePageUrl(previewServerUrl, path);
  const beforeUrl = url ? withDraftPointer(url.toString(), DRAFT_OFF) : null;
  const afterUrl = url ? compareDraftUrl(url, draft) : null;

  const rawDiff: GitDiffResult = {
    diffs: Object.fromEntries(
      change.filepaths.flatMap((p) => {
        const entry = diff?.diffs[p];
        return entry ? [[p, entry] as const] : [];
      }),
    ),
  };
  const hasBody = Object.keys(rawDiff.diffs).length > 0;

  const pathHint =
    sectionKey !== null
      ? null
      : change.kind !== "page"
        ? t("thread.publishCompare.globalHint")
        : change.pagePath && extractPathParams(change.pagePath).length > 0
          ? t("thread.publishCompare.dynamicHint", {
              template: change.pagePath,
            })
          : null;

  // A new or removed code file says nothing about whether the page existed.
  const beforePane =
    change.status === "new" && change.kind !== "other" ? (
      <ComparePlaceholder
        icon={<Plus className="size-5 text-brand" />}
        title={t("thread.publishCompare.newTitle")}
        description={t("thread.publishCompare.newDescription")}
      />
    ) : (
      <CompareFrame
        url={beforeUrl}
        device={device}
        title={t("thread.publishCompare.before")}
        missing={t("thread.publishCompare.enterPath")}
      />
    );

  const afterPane =
    change.status === "removed" && change.kind !== "other" ? (
      <ComparePlaceholder
        icon={<Trash01 className="size-5 text-destructive" />}
        title={t("thread.publishCompare.removedTitle")}
        description={t("thread.publishCompare.removedDescription")}
      />
    ) : (
      <CompareFrame
        url={afterUrl}
        device={device}
        title={t("thread.publishCompare.after")}
        missing={
          url
            ? t("thread.publishCompare.draftUnavailable")
            : t("thread.publishCompare.enterPath")
        }
      />
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/40">
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2.5 max-md:pr-12">
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
            <TabsTrigger value="code" className="px-3 text-xs">
              {t("thread.publishCompare.code")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
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

      {view === "code" ? (
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

/**
 * The page at a fixed logical width, scaled to the pane — a faithful miniature
 * of the layout instead of a reflow into whatever breakpoint the half-width
 * pane happens to hit.
 */
function CompareFrame({
  url,
  device,
  title,
  missing,
}: {
  url: string | null;
  device: CompareDevice;
  title: string;
  missing: string;
}) {
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

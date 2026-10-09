/**
 * Library cards — the Figma "Library" card grid pieces (file qFc7wr91,
 * node 7870-5644): folder cards, compact file cards and the "Recently
 * added" cards with a content thumbnail.
 *
 * Thumbnails (phase-2 cut): images render the real bytes, small text-ish
 * files render a snippet (shares the FilePreview text cache), everything
 * else gets a large type icon. Real xlsx/pptx renders are phase 3.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFileText } from "@/hooks/use-org-fs";
import {
  DotsVertical,
  Download01,
  Folder,
  Globe01,
  Key01,
  Share07,
  Trash01,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Markdown } from "@decocms/ui/components/markdown.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { FileTypeIcon } from "@/components/file-type-icon";
import { KEYS } from "@/lib/query-keys";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
]);
const CSV_EXTS = new Set(["csv", "tsv"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const TEXT_THUMB_EXTS = new Set(["txt", "json", "log", "yaml", "yml", "xml"]);
/** Don't fetch snippet bytes for anything bigger than this. */
const MAX_TEXT_THUMB_BYTES = 256 * 1024;

function extOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

/** Fetch-as-text helper for the CSV thumbnail (needs a Range header). */
async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return res.text();
}

/** Shared "Share" menu item — opens the share dialog for a file/folder. */
function ShareMenuItem({ onShare, t }: { onShare: () => void; t: TFunction }) {
  return (
    <DropdownMenuItem onClick={onShare}>
      <Share07 size={14} />
      {t("library.cards.share")}
    </DropdownMenuItem>
  );
}

/** How a card is shared: public/password by its own flag, or inherited. */
export type PublicState = "public" | "password" | "inherited";

/** Small badge marking a shared file/folder (globe = public, key = password,
 *  muted globe = inherited from a parent). */
export function PublicBadge({
  state,
  t,
}: {
  state: PublicState;
  t: TFunction;
}) {
  const label =
    state === "password"
      ? t("library.cards.passwordProtected")
      : state === "inherited"
        ? t("library.cards.sharedViaParent")
        : t("library.cards.publicBadge");
  const Icon = state === "password" ? Key01 : Globe01;
  return (
    <span title={label} className="mt-0.5 flex shrink-0 items-center">
      <Icon
        size={12}
        className={cn(
          state === "inherited" ? "text-muted-foreground/60" : "text-primary",
        )}
        aria-label={label}
      />
    </span>
  );
}

/** The one entry menu — browse/share/download/delete, whichever the caller
 *  passes. Shared by every presentation of an entry (row, card, tile) so a
 *  folder offers the same verbs wherever it is drawn. Renders nothing when
 *  there is nothing to offer. */
export function EntryActionsMenu({
  label,
  onBrowse,
  onShare,
  download,
  onDelete,
  t,
}: {
  label: string;
  onBrowse?: () => void;
  onShare?: () => void;
  /** Files only: a direct byte URL and the name to save it under. */
  download?: { url: string; filename: string };
  onDelete?: () => void;
  t: TFunction;
}) {
  if (!onBrowse && !onShare && !download && !onDelete) return undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 opacity-0 transition-opacity group-hover/card:opacity-100 data-[state=open]:opacity-100"
          onClick={(e) => e.stopPropagation()}
          aria-label={t("library.cards.actionsFor", { label })}
        >
          <DotsVertical size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {onBrowse && (
          <DropdownMenuItem onClick={onBrowse}>
            <Folder size={14} />
            {t("library.cards.browseFiles")}
          </DropdownMenuItem>
        )}
        {onShare && <ShareMenuItem onShare={onShare} t={t} />}
        {download && (
          <DropdownMenuItem asChild>
            <a href={download.url} download={download.filename}>
              <Download01 size={14} />
              {t("library.cards.download")}
            </a>
          </DropdownMenuItem>
        )}
        {onDelete && (
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash01 size={14} />
            {t("library.cards.delete")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A file by its own first page: the grid view's card and the drive's
 *  recent files. The card is a click-and-keyboard div, since a real button
 *  can't wrap the actions dropdown. */
export function FileCard({
  size = 0,
  filename,
  downloadUrl,
  subtitle,
  publicState,
  selected = false,
  compact = false,
  onOpen,
  onShare,
  onDelete,
  draggable,
  onDragStart,
  onContextMenu,
}: {
  size?: number;
  filename: string;
  downloadUrl: string;
  subtitle: string;
  publicState?: PublicState;
  /** Its preview is open beside the list. */
  selected?: boolean;
  /** A short preview strip, for a row of recents above the list. */
  compact?: boolean;
  onOpen: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      draggable={draggable}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
      className="group/card surface surface-interactive focus-ring flex min-w-0 cursor-pointer flex-col gap-2.5 p-1.5 pb-2 text-left aria-pressed:bg-accent"
    >
      <Thumb
        filename={filename}
        size={size}
        downloadUrl={downloadUrl}
        compact={compact}
      />
      <div className="flex min-w-0 items-center gap-2 pl-1.5">
        <FileTypeIcon filename={filename} className="h-5 w-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate text-sm font-medium text-foreground"
              title={filename}
            >
              {filename}
            </span>
            {publicState && <PublicBadge state={publicState} t={t} />}
          </span>
          <span className="text-meta truncate" title={subtitle}>
            {subtitle}
          </span>
        </div>
        <EntryActionsMenu
          label={filename}
          download={{ url: downloadUrl, filename }}
          onShare={onShare}
          onDelete={onDelete}
          t={t}
        />
      </div>
    </div>
  );
}

/**
 * Defers rendering children until the sentinel div enters the viewport.
 * Prevents N parallel network requests when many thumbnails mount at once.
 * With `whileVisible`, the children also unmount once the card scrolls away,
 * for thumbnails that keep costing while mounted (a live page).
 * The `setVisible` setter is stable across renders so capturing it in the
 * lazy initializer is safe without a ref.
 */
function LazyThumb({
  children,
  whileVisible = false,
}: {
  children: ReactNode;
  whileVisible?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [attachSentinel] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          if (!whileVisible) obs.disconnect();
        } else if (whileVisible) {
          setVisible(false);
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(node);
    return () => obs.disconnect();
  });
  return (
    <div ref={attachSentinel} className="h-full w-full">
      {visible && children}
    </div>
  );
}

function TextThumb({ url, filename }: { url: string; filename: string }) {
  const { data } = useFileText(url);
  if (data === undefined) return null;
  if (data === null || !data.trim()) return <IconThumb filename={filename} />;
  return (
    <pre className="pointer-events-none h-full w-full overflow-hidden bg-background p-3 font-mono text-[9px] leading-[1.5] text-muted-foreground select-none">
      {data.slice(0, 2000)}
    </pre>
  );
}

/** Markdown reads as the page it renders, at half size. */
function MarkdownThumb({ url, filename }: { url: string; filename: string }) {
  const { data } = useFileText(url);
  if (data === undefined) return null;
  if (data === null || !data.trim()) return <IconThumb filename={filename} />;
  return (
    <div className="pointer-events-none h-[200%] w-[200%] origin-top-left scale-50 overflow-hidden bg-background p-6 text-sm select-none">
      <Markdown>{data.slice(0, 4000)}</Markdown>
    </div>
  );
}

function IconThumb({ filename }: { filename: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <FileTypeIcon filename={filename} className="h-14 w-11 opacity-60" />
    </div>
  );
}

function CsvThumb({ url, ext }: { url: string; ext: string }) {
  const { data } = useQuery({
    queryKey: KEYS.csvThumb(url),
    queryFn: () => fetchText(url, { headers: { Range: "bytes=0-8191" } }),
    staleTime: 60_000,
    retry: false,
  });
  if (!data) return null;
  const sep = ext === "tsv" ? "\t" : ",";
  const rows = data
    .split("\n")
    .filter(Boolean)
    .slice(0, 7)
    .map((line) =>
      line
        .split(sep)
        .slice(0, 6)
        .map((cell) => cell.trim().replace(/^"|"$/g, "")),
    );
  if (rows.length === 0) return null;
  return (
    <div className="pointer-events-none h-full w-full overflow-hidden bg-background p-2 select-none">
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={cn(ri === 0 && "bg-muted/50 font-medium")}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="max-w-[56px] overflow-hidden border border-border/30 px-1 py-px text-[7px] leading-[1.4] text-muted-foreground"
                  style={{ maxWidth: 56 }}
                >
                  <span className="block truncate">{cell}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A page renders as itself, shrunk: at a quarter scale a deck's cover is
 *  recognisable where its source text is not. No pointer, no focus. A live
 *  page costs while mounted, so it mounts only while its card is on screen. */
function HtmlThumb({ url, filename }: { url: string; filename: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="pointer-events-none relative h-full w-full overflow-hidden">
      {!loaded && <IconThumb filename={filename} />}
      <iframe
        src={url}
        title=""
        aria-hidden
        tabIndex={-1}
        sandbox="allow-scripts"
        onLoad={() => setLoaded(true)}
        className={cn(
          "absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25 border-0 bg-white transition-opacity duration-300",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function Thumb({
  filename,
  size,
  downloadUrl,
  compact = false,
}: {
  filename: string;
  size: number;
  downloadUrl: string;
  compact?: boolean;
}) {
  const ext = extOf(filename);
  let inner: ReactNode;
  if (IMAGE_EXTS.has(ext)) {
    inner = (
      <img
        src={downloadUrl}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  } else if (VIDEO_EXTS.has(ext)) {
    // `#t=0.1` + preload="metadata" paints the first frame without a full
    // download — but only when the card is actually visible.
    inner = (
      <LazyThumb>
        <video
          src={`${downloadUrl}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          className="pointer-events-none h-full w-full object-cover"
        />
      </LazyThumb>
    );
  } else if (ext === "pdf") {
    // Full PDF embed is too heavy for a card thumbnail; show the type icon
    // and let the preview panel handle the real render.
    inner = <IconThumb filename={filename} />;
  } else if (CSV_EXTS.has(ext)) {
    inner = (
      <LazyThumb>
        <CsvThumb url={downloadUrl} ext={ext} />
      </LazyThumb>
    );
  } else if (ext === "html" || ext === "htm") {
    inner = (
      <LazyThumb whileVisible>
        <HtmlThumb url={downloadUrl} filename={filename} />
      </LazyThumb>
    );
  } else if (
    (ext === "md" || ext === "markdown") &&
    size <= MAX_TEXT_THUMB_BYTES
  ) {
    inner = (
      <LazyThumb>
        <MarkdownThumb url={downloadUrl} filename={filename} />
      </LazyThumb>
    );
  } else if (TEXT_THUMB_EXTS.has(ext) && size <= MAX_TEXT_THUMB_BYTES) {
    inner = (
      <LazyThumb>
        <TextThumb url={downloadUrl} filename={filename} />
      </LazyThumb>
    );
  } else {
    inner = <IconThumb filename={filename} />;
  }
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-lg border border-border/60 bg-muted/30",
        compact ? "aspect-[3/1]" : "aspect-[400/265]",
      )}
    >
      {inner}
    </div>
  );
}

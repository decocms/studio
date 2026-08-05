/**
 * Library cards — the Figma "Library" card grid pieces (file qFc7wr91,
 * node 7870-5644): folder cards, compact file cards and the "Recently
 * added" cards with a content thumbnail.
 *
 * Thumbnails (phase-2 cut): images render the real bytes, small text-ish
 * files render a snippet (shares the FilePreview text cache), everything
 * else gets a large type icon. Real xlsx/pptx renders are phase 3.
 */

import type { ComponentType, ReactNode, SVGProps } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFileText } from "@/hooks/use-org-fs";
import {
  DotsVertical,
  Download01,
  Folder,
  Globe01,
  Key01,
  Palette,
  Share07,
  Trash01,
  Zap,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { describeFileType, FileTypeIcon } from "@/components/file-type-icon";
import { FolderIcon, type FolderTone } from "@/components/folder-icon";
import { KEYS } from "@/lib/query-keys";
import { parseBrandTokens } from "./brand";
import { parseSkillMd } from "./skill";

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
const TEXT_THUMB_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "log",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
]);
/** Don't fetch snippet bytes for anything bigger than this. */
const MAX_TEXT_THUMB_BYTES = 256 * 1024;

/** Compact relative time ("10h ago", per the design) — long forms like
 *  "about 2 hours ago" squeeze the filename out of the card. */
export function timeAgo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
function PublicBadge({ state, t }: { state: PublicState; t: TFunction }) {
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

function FileActions({
  downloadUrl,
  filename,
  onShare,
  onDelete,
  t,
}: {
  downloadUrl: string;
  filename: string;
  onShare?: () => void;
  onDelete?: () => void;
  t: TFunction;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 opacity-0 transition-opacity group-hover/card:opacity-100 data-[state=open]:opacity-100"
          onClick={(e) => e.stopPropagation()}
          aria-label={t("library.cards.actionsFor", { filename })}
        >
          <DotsVertical size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {onShare && <ShareMenuItem onShare={onShare} t={t} />}
        <DropdownMenuItem asChild>
          <a href={downloadUrl} download={filename}>
            <Download01 size={14} />
            {t("library.cards.download")}
          </a>
        </DropdownMenuItem>
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

/** Shared "Actions" dropdown for a card: browse/share/delete, whichever
 *  the caller passes. Renders nothing if none are given. */
function EntryActionsMenu({
  label,
  onBrowse,
  onShare,
  onDelete,
  t,
}: {
  label: string;
  onBrowse?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  t: TFunction;
}) {
  if (!onBrowse && !onShare && !onDelete) return undefined;
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

function CardShell({
  onOpen,
  children,
  className,
  draggable,
  onDragStart,
  onContextMenu,
  onDragOver,
  onDrop,
  onDragLeave,
}: {
  onOpen: () => void;
  children: React.ReactNode;
  className?: string;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  // A real <button> can't wrap the actions dropdown (nested buttons), so the
  // card is a click-and-keyboard div.
  return (
    <div
      role="button"
      tabIndex={0}
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
      onDragOver={(e) => {
        onDragOver?.(e);
        if (onDrop) {
          e.preventDefault();
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        onDragLeave?.(e);
        setIsDragOver(false);
      }}
      onDrop={(e) => {
        onDrop?.(e);
        setIsDragOver(false);
      }}
      className={cn(
        "group/card flex cursor-pointer flex-col gap-3 rounded-2xl border border-border bg-background p-4 text-left transition-colors hover:border-border hover:bg-muted/40",
        isDragOver && onDrop && "border-primary bg-primary/5",
        className,
      )}
    >
      {children}
    </div>
  );
}

function CardHeader({
  icon,
  name,
  meta,
  subtitle,
  publicState,
  actions,
  t,
}: {
  icon: React.ReactNode;
  name: string;
  meta?: string;
  subtitle?: string;
  /** Render the "public" globe badge next to the name (own vs inherited). */
  publicState?: PublicState;
  actions?: React.ReactNode;
  t: TFunction;
}) {
  return (
    <div className="flex w-full items-center gap-2.5">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex items-start gap-3">
          <span
            className="min-w-0 flex-1 truncate text-[13px] text-foreground"
            title={name}
          >
            {name}
          </span>
          {publicState && <PublicBadge state={publicState} t={t} />}
          {meta && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {meta}
            </span>
          )}
        </div>
        {subtitle && (
          <span
            className="truncate text-xs text-muted-foreground"
            title={subtitle}
          >
            {subtitle}
          </span>
        )}
      </div>
      {actions}
    </div>
  );
}

export function FolderCard({
  name,
  meta,
  subtitle,
  glyph,
  tone,
  readOnly,
  publicState,
  onOpen,
  onShare,
  onDelete,
  draggable,
  onDragStart,
  onContextMenu,
  onDrop,
}: {
  name: string;
  meta?: string;
  subtitle?: string;
  /** Well-known-folder mark rendered on the folder body (skills/outputs/…). */
  glyph?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Folder palette — graphite for the system folders the product fills. */
  tone?: FolderTone;
  /** View-only corner badge (public sets). */
  readOnly?: boolean;
  /** Public badge state (own = published here, inherited = via a parent). */
  publicState?: PublicState;
  onOpen: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  const t = useT();
  return (
    <CardShell
      onOpen={onOpen}
      draggable={draggable}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
      onDrop={onDrop}
    >
      <CardHeader
        icon={
          <FolderIcon
            glyph={glyph}
            tone={tone}
            readOnly={readOnly}
            className="size-8 shrink-0"
          />
        }
        name={name}
        meta={meta}
        subtitle={subtitle}
        publicState={publicState}
        actions={
          <EntryActionsMenu
            label={name}
            onShare={onShare}
            onDelete={onDelete}
            t={t}
          />
        }
        t={t}
      />
    </CardShell>
  );
}

export function FileCard({
  filename,
  updatedAt,
  downloadUrl,
  subtitle,
  publicState,
  onOpen,
  onShare,
  onDelete,
  draggable,
  onDragStart,
  onContextMenu,
}: {
  filename: string;
  updatedAt: string;
  downloadUrl: string;
  /** Overrides the file-type description (e.g. the containing folder). */
  subtitle?: string;
  publicState?: PublicState;
  onOpen: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  return (
    <CardShell
      onOpen={onOpen}
      draggable={draggable}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
    >
      <CardHeader
        icon={
          <FileTypeIcon filename={filename} className="h-8 w-6.5 shrink-0" />
        }
        name={filename}
        meta={timeAgo(updatedAt)}
        subtitle={subtitle ?? describeFileType(filename)}
        publicState={publicState}
        actions={
          <FileActions
            downloadUrl={downloadUrl}
            filename={filename}
            onShare={onShare}
            onDelete={onDelete}
            t={t}
          />
        }
        t={t}
      />
    </CardShell>
  );
}

/**
 * SkillCard — a dir in the Claude Code skill format, rendered first-class:
 * zap tile, frontmatter name/description (fetched lazily, shared with the
 * preview's text cache; plain-markdown skills fall back to dir name + first
 * paragraph). Click opens the skill preview; the menu still reaches the
 * underlying folder.
 */
export function SkillCard({
  dirName,
  updatedAt,
  skillMdUrl,
  publicState,
  onOpen,
  onBrowse,
  onShare,
  onDelete,
  draggable,
  onDragStart,
  onContextMenu,
}: {
  dirName: string;
  updatedAt: string;
  /** Byte URL of the dir's SKILL.md. */
  skillMdUrl: string;
  publicState?: PublicState;
  onOpen: () => void;
  /** Open the underlying folder listing. */
  onBrowse: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const { data } = useFileText(skillMdUrl);
  const meta = data ? parseSkillMd(data) : null;

  return (
    <CardShell
      onOpen={onOpen}
      draggable={draggable}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
    >
      <CardHeader
        icon={
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Zap size={16} />
          </div>
        }
        name={meta?.name ?? dirName}
        meta={timeAgo(updatedAt)}
        subtitle={t("library.cards.skill")}
        publicState={publicState}
        actions={
          <EntryActionsMenu
            label={dirName}
            onBrowse={onBrowse}
            onShare={onShare}
            onDelete={onDelete}
            t={t}
          />
        }
        t={t}
      />
      <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
        {meta?.description ?? ""}
      </p>
    </CardShell>
  );
}

/**
 * BrandCard — a brand folder (org-fs `brands/<name>/`), rendered first-class:
 * palette tile, the dir name, and a strip of color swatches parsed from
 * tokens.css (fetched lazily, shared with the preview's text cache). Click
 * opens the brand preview; the menu reaches the underlying folder.
 */
export function BrandCard({
  dirName,
  updatedAt,
  tokensUrl,
  onOpen,
  onBrowse,
  onDelete,
  draggable,
  onDragStart,
  onContextMenu,
}: {
  dirName: string;
  updatedAt: string;
  /** Byte URL of the dir's tokens.css (may 404 for brand.md-only folders). */
  tokensUrl: string;
  onOpen: () => void;
  /** Open the underlying folder listing. */
  onBrowse: () => void;
  onDelete?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const { data } = useFileText(tokensUrl);
  const swatches = data
    ? parseBrandTokens(data)
        .filter((token) => token.isColor)
        .slice(0, 6)
    : [];

  return (
    <CardShell
      onOpen={onOpen}
      draggable={draggable}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
    >
      <CardHeader
        icon={
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Palette size={16} />
          </div>
        }
        name={dirName}
        meta={timeAgo(updatedAt)}
        subtitle={t("library.cards.brand")}
        actions={
          <EntryActionsMenu
            label={dirName}
            onBrowse={onBrowse}
            onDelete={onDelete}
            t={t}
          />
        }
        t={t}
      />
      <div className="flex min-h-5 items-center gap-1.5">
        {swatches.map((swatch) => (
          <span
            key={swatch.name}
            className="size-5 rounded-full border border-border/60"
            style={{ backgroundColor: swatch.value }}
            title={`${swatch.name}: ${swatch.value}`}
          />
        ))}
      </div>
    </CardShell>
  );
}

/**
 * Defers rendering children until the sentinel div enters the viewport.
 * Prevents N parallel network requests when many thumbnails mount at once.
 * The `setVisible` setter is stable across renders so capturing it in the
 * lazy initializer is safe without a ref.
 */
function LazyThumb({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [attachSentinel] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(node);
  });
  if (visible) return <>{children}</>;
  return <div ref={attachSentinel} className="h-full w-full" />;
}

function TextThumb({ url }: { url: string }) {
  const { data } = useFileText(url);
  if (!data) return null;
  return (
    <pre className="pointer-events-none h-full w-full overflow-hidden bg-background p-3 font-mono text-[9px] leading-[1.5] text-muted-foreground select-none">
      {data.slice(0, 2000)}
    </pre>
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

function Thumb({
  filename,
  size,
  downloadUrl,
}: {
  filename: string;
  size: number;
  downloadUrl: string;
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
    inner = (
      <div className="flex h-full w-full items-center justify-center">
        <FileTypeIcon filename={filename} className="h-14 w-11 opacity-60" />
      </div>
    );
  } else if (CSV_EXTS.has(ext)) {
    inner = (
      <LazyThumb>
        <CsvThumb url={downloadUrl} ext={ext} />
      </LazyThumb>
    );
  } else if (TEXT_THUMB_EXTS.has(ext) && size <= MAX_TEXT_THUMB_BYTES) {
    inner = (
      <LazyThumb>
        <TextThumb url={downloadUrl} />
      </LazyThumb>
    );
  } else {
    inner = (
      <div className="flex h-full w-full items-center justify-center">
        <FileTypeIcon filename={filename} className="h-14 w-11 opacity-60" />
      </div>
    );
  }
  return (
    <div className="aspect-[400/265] w-full overflow-hidden rounded-lg border border-border/60 bg-muted/30">
      {inner}
    </div>
  );
}

/** "Recently added" card — file card plus a content thumbnail. */
export function RecentFileCard(props: {
  filename: string;
  updatedAt: string;
  size: number;
  downloadUrl: string;
  /** Overrides the file-type description (e.g. the containing folder). */
  subtitle?: string;
  publicState?: PublicState;
  onOpen: () => void;
  onShare?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  return (
    <CardShell onOpen={props.onOpen}>
      <CardHeader
        icon={
          <FileTypeIcon
            filename={props.filename}
            className="h-8 w-6.5 shrink-0"
          />
        }
        name={props.filename}
        meta={timeAgo(props.updatedAt)}
        subtitle={props.subtitle ?? describeFileType(props.filename)}
        publicState={props.publicState}
        actions={
          <FileActions
            downloadUrl={props.downloadUrl}
            filename={props.filename}
            onShare={props.onShare}
            onDelete={props.onDelete}
            t={t}
          />
        }
        t={t}
      />
      <Thumb
        filename={props.filename}
        size={props.size}
        downloadUrl={props.downloadUrl}
      />
    </CardShell>
  );
}

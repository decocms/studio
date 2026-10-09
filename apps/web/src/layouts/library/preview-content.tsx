/**
 * Shared body for the two Library file-preview surfaces — the near-fullscreen
 * dialog (mobile / shared links) and the right-side panel (desktop Library +
 * chat side tab). Resolves the entry via `stat`, renders the shared FilePreview
 * (or the handshake-upgrading HtmlPreviewPanel for HTML), plus a toolbar with
 * download / open-in-new-tab and an optional "See in library" jump.
 *
 * Only the chrome differs, and the caller owns it: the dialog wraps this in
 * <DialogContent> and supplies a built-in close X (so this renders a sr-only/
 * inline <DialogTitle> for a11y and a spacer to clear that X), while the panel
 * wraps it in a plain column and gets an explicit close button here.
 */

import { Button } from "@decocms/ui/components/button.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { DialogTitle } from "@decocms/ui/components/dialog.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  Download01,
  LinkExternal01,
  Maximize01,
  Minimize01,
  XClose,
} from "@untitledui/icons";
import { SeeInLibraryLink } from "./see-in-library-link";
import { Page } from "@/components/page";
import {
  type ToolbarPlacement,
  toolbarButton,
} from "@/components/toolbar-placement";
import { useT } from "@/i18n/use-t.ts";
import {
  FilePreview,
  FilePreviewShimmer,
  formatSize,
} from "@/components/file-preview";
import { HtmlPreviewPanel } from "@/components/deck/html-preview-panel";
import { FileTypeIcon } from "@/components/file-type-icon";
import {
  entryMarker,
  useOrgFsDownloadUrl,
  useOrgFsStat,
} from "@/hooks/use-org-fs";
import { FileShareButton } from "./file-share-button";
import { basename, parseLibraryPath } from "./location";

const isHtml = (name: string) => /\.html?$/i.test(name);

/** `aside` is a surface of its own, so its bar is a full panel topbar. */
export type LibraryPreviewVariant = "dialog" | "panel" | "aside";

/** The bar's height and padding for each variant. */
function barClassName(variant: LibraryPreviewVariant): string {
  switch (variant) {
    // The dialog clears its built-in close X with pr-12.
    case "dialog":
      return "h-11 py-1 pr-12 pl-2";
    case "panel":
      return "h-9 px-2";
    case "aside":
      return "h-12 gap-2 px-1.5";
    default: {
      const unhandled: never = variant;
      return unhandled;
    }
  }
}

export interface LibraryPreviewProps {
  /** Browse-grammar path of the open file ("<volume>/<path...>"). */
  previewPath: string;
  onClose: () => void;
  /** Beside the list or across the page; `onToggle` when the host can swap. */
  expand?: { expanded: boolean; onToggle?: () => void };
  /** Render a "See in library" link (set when previewing outside the Library). */
  showSeeInLibrary?: boolean;
}

function ExpandButton({
  expanded,
  onToggle,
  placement,
}: {
  expanded: boolean;
  onToggle: () => void;
  placement: ToolbarPlacement;
}) {
  const t = useT();
  return (
    <IconButton
      {...toolbarButton(placement)}
      label={t(
        expanded
          ? "library.previewContent.collapse"
          : "library.previewContent.expand",
      )}
      tooltipSide="bottom"
      onClick={onToggle}
    >
      {expanded ? <Minimize01 size={14} /> : <Maximize01 size={14} />}
    </IconButton>
  );
}

function CloseButton({
  onClose,
  placement = "bar",
}: {
  onClose: () => void;
  placement?: ToolbarPlacement;
}) {
  const t = useT();
  return (
    <IconButton
      {...toolbarButton(placement)}
      label={t("library.previewContent.close")}
      tooltipSide="bottom"
      onClick={onClose}
    >
      <XClose size={14} />
    </IconButton>
  );
}

export function LibraryFilePreview({
  previewPath,
  onClose,
  expand,
  showSeeInLibrary = false,
  variant,
}: LibraryPreviewProps & { variant: LibraryPreviewVariant }) {
  const t = useT();
  const location = parseLibraryPath(previewPath);
  const { volume, dirPath: filePath } = location;
  const { data: entry, isPending } = useOrgFsStat(volume, filePath);
  const downloadUrl = useOrgFsDownloadUrl(volume ?? "");
  const filename = basename(filePath);
  const isDialog = variant === "dialog";

  /** Expanded, the controls join the page header, which already names the
   *  file. */
  const placement: ToolbarPlacement = expand?.expanded
    ? "topbar"
    : variant === "aside"
      ? "aside"
      : "bar";
  const button = toolbarButton(placement);
  const expandButton = expand?.onToggle && (
    <ExpandButton
      expanded={expand.expanded}
      onToggle={expand.onToggle}
      placement={placement}
    />
  );
  const seeInLibrary = showSeeInLibrary ? (
    <SeeInLibraryLink previewPath={previewPath} />
  ) : null;

  const file =
    entry && entry.kind === "file"
      ? {
          key: previewPath,
          filename,
          size: entry.size,
          downloadUrl: downloadUrl(entry.path),
        }
      : null;

  // HTML hands the whole panel (toolbar included) to the shared surface so it
  // is pixel-identical to the chat deck tab. The dialog keeps a sr-only title
  // for a11y and a spacer to clear its built-in close X; the panel appends an
  // explicit close button. Keyed per file: the editor hook holds per-file
  // state (source cache, debounced saves) that must not survive a path switch.
  if (file && entry && isHtml(filename)) {
    return (
      <>
        {isDialog && <DialogTitle className="sr-only">{filename}</DialogTitle>}
        <HtmlPreviewPanel
          key={previewPath}
          readUrl={file.downloadUrl}
          marker={entryMarker(entry)}
          toolbarClassName={
            variant === "aside" ? barClassName(variant) : undefined
          }
          title={filename}
          placement={placement}
          savePath={volume === "home" ? filePath : undefined}
          trailing={
            <>
              <FileShareButton
                volume={volume ?? ""}
                path={filePath}
                shareMode={entry.shareMode ?? "private"}
                effectivePublic={entry.effectivePublic ?? false}
                url={window.location.origin + file.downloadUrl}
                placement={placement}
              />
              {seeInLibrary}
              {isDialog ? (
                <div className="w-8 shrink-0" />
              ) : (
                <>
                  {expandButton}
                  <CloseButton onClose={onClose} placement={placement} />
                </>
              )}
            </>
          }
        />
      </>
    );
  }

  const actions = (
    <>
      {file && (
        <>
          <FileShareButton
            volume={volume ?? ""}
            path={filePath}
            shareMode={entry?.shareMode ?? "private"}
            effectivePublic={entry?.effectivePublic ?? false}
            url={window.location.origin + file.downloadUrl}
            placement={placement}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant={button.variant} size={button.size} asChild>
                <a href={file.downloadUrl} download={file.filename}>
                  <Download01 size={14} />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("library.previewContent.download")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={button.variant}
                size={button.size}
                onClick={() =>
                  window.open(file.downloadUrl, "_blank", "noopener")
                }
              >
                <LinkExternal01 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("library.previewContent.openInNewTab")}
            </TooltipContent>
          </Tooltip>
        </>
      )}
      {!isDialog && (
        <>
          {expandButton}
          <CloseButton onClose={onClose} placement={placement} />
        </>
      )}
    </>
  );

  return (
    <>
      {placement === "topbar" ? (
        <Page.Actions>{actions}</Page.Actions>
      ) : (
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 border-b border-border/60",
            barClassName(variant),
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
            <FileTypeIcon
              filename={filename}
              className="h-4.5 w-3.5 shrink-0"
            />
            {isDialog ? (
              <DialogTitle className="truncate text-xs font-medium text-foreground">
                {filename}
              </DialogTitle>
            ) : (
              <span
                className={cn(
                  "truncate font-medium text-foreground",
                  placement === "aside" ? "text-sm" : "text-xs",
                )}
              >
                {filename}
              </span>
            )}
            {file && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatSize(file.size)}
              </span>
            )}
          </div>
          {actions}
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-background">
        {file ? (
          <FilePreview file={file} />
        ) : isPending ? (
          <FilePreviewShimmer />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <FileTypeIcon filename={filename} className="h-7.5 w-6" />
            <span className="text-sm text-muted-foreground">
              {t("library.previewContent.fileNotAvailable")}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

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

import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { DialogTitle } from "@deco/ui/components/dialog.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Download01, LinkExternal01, XClose } from "@untitledui/icons";
import { useParams } from "@tanstack/react-router";
import { useT } from "@/web/i18n/use-t.ts";
import {
  FilePreview,
  FilePreviewShimmer,
  formatSize,
} from "@/web/components/file-preview";
import { HtmlPreviewPanel } from "@/web/components/deck/html-preview-panel";
import { FileTypeIcon } from "@/web/components/file-type-icon";
import {
  entryMarker,
  useOrgFsDownloadUrl,
  useOrgFsStat,
} from "@/web/hooks/use-org-fs";
import { FileShareButton } from "./file-share-button";
import { basename, parseLibraryPath } from "./location";
import { SeeInLibraryLink } from "./see-in-library-link";

const isHtml = (name: string) => /\.html?$/i.test(name);

export type LibraryPreviewVariant = "dialog" | "panel";

export interface LibraryPreviewProps {
  /** Browse-grammar path of the open file ("<volume>/<path...>"). */
  previewPath: string;
  onClose: () => void;
  /** Render a "See in library" link (set when previewing outside the Library). */
  showSeeInLibrary?: boolean;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <XClose size={14} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {t("library.previewContent.close")}
      </TooltipContent>
    </Tooltip>
  );
}

export function LibraryFilePreview({
  previewPath,
  onClose,
  showSeeInLibrary = false,
  variant,
}: LibraryPreviewProps & { variant: LibraryPreviewVariant }) {
  const t = useT();
  const location = parseLibraryPath(previewPath);
  const { volume, dirPath: filePath } = location;
  const { data: entry, isPending } = useOrgFsStat(volume, filePath);
  const downloadUrl = useOrgFsDownloadUrl(volume ?? "");
  const filename = basename(filePath);
  const { org } = useParams({ strict: false }) as { org?: string };
  const isDialog = variant === "dialog";

  const seeInLibrary =
    showSeeInLibrary && org ? (
      <SeeInLibraryLink org={org} previewPath={previewPath} />
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
          title={filename}
          savePath={volume === "home" ? filePath : undefined}
          trailing={
            <>
              <FileShareButton
                volume={volume ?? ""}
                path={filePath}
                shareMode={entry.shareMode ?? "private"}
                effectivePublic={entry.effectivePublic ?? false}
                url={window.location.origin + file.downloadUrl}
              />
              {seeInLibrary}
              {isDialog ? (
                <div className="w-8 shrink-0" />
              ) : (
                <CloseButton onClose={onClose} />
              )}
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-b border-border/60",
          // Dialog clears its built-in close X with pr-12; panel owns its close.
          isDialog ? "h-11 py-1 pr-12 pl-2" : "h-9 px-2",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <FileTypeIcon filename={filename} className="h-4.5 w-3.5 shrink-0" />
          {isDialog ? (
            <DialogTitle className="truncate text-xs font-medium text-foreground">
              {filename}
            </DialogTitle>
          ) : (
            <span className="truncate text-xs font-medium text-foreground">
              {filename}
            </span>
          )}
          {file && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatSize(file.size)}
            </span>
          )}
        </div>
        {seeInLibrary}
        {file && (
          <>
            <FileShareButton
              volume={volume ?? ""}
              path={filePath}
              shareMode={entry?.shareMode ?? "private"}
              effectivePublic={entry?.effectivePublic ?? false}
              url={window.location.origin + file.downloadUrl}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" asChild>
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
                  variant="ghost"
                  size="icon"
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
        {!isDialog && <CloseButton onClose={onClose} />}
      </div>
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

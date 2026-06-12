/**
 * Library file preview — near-fullscreen dialog over the shared FilePreview
 * viewer. URL-driven (`?preview=<browse path>`) so a preview link survives
 * reload: the entry is re-resolved via `stat`, not read off list caches.
 */

import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Download01, LinkExternal01 } from "@untitledui/icons";
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
import { basename, parseLibraryPath } from "./location";

const isHtml = (name: string) => /\.html?$/i.test(name);

export function LibraryPreviewDialog({
  previewPath,
  onClose,
}: {
  /** Browse-grammar path of the open file ("<volume>/<path...>"). */
  previewPath: string;
  onClose: () => void;
}) {
  const location = parseLibraryPath(previewPath);
  const { volume, dirPath: filePath } = location;
  const { data: entry, isPending } = useOrgFsStat(volume, filePath);
  const downloadUrl = useOrgFsDownloadUrl(volume ?? "");
  const filename = basename(filePath);

  const file =
    entry && entry.kind === "file"
      ? {
          key: previewPath,
          filename,
          size: entry.size,
          downloadUrl: downloadUrl(entry.path),
        }
      : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex h-[88vh] w-[94vw] max-w-none! flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl!">
        {file && entry && isHtml(filename) ? (
          // HTML uses the shared handshake-upgrading panel (same single
          // toolbar as the chat deck tab). sr-only title keeps the dialog
          // accessible; the spacer clears the dialog's built-in close X.
          <>
            <DialogTitle className="sr-only">{filename}</DialogTitle>
            <HtmlPreviewPanel
              key={previewPath}
              readUrl={file.downloadUrl}
              marker={entryMarker(entry)}
              title={filename}
              savePath={volume === "home" ? filePath : undefined}
              trailing={<div className="w-8 shrink-0" />}
            />
          </>
        ) : (
          <>
            <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 py-1 pr-12 pl-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
                <FileTypeIcon
                  filename={filename}
                  className="h-4.5 w-3.5 shrink-0"
                />
                <DialogTitle className="truncate text-xs font-medium text-foreground">
                  {filename}
                </DialogTitle>
                {file && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatSize(file.size)}
                  </span>
                )}
              </div>
              {file && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" asChild>
                        <a href={file.downloadUrl} download={file.filename}>
                          <Download01 size={14} />
                        </a>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Download</TooltipContent>
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
                      Open in new tab
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
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
                    This file is no longer available.
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

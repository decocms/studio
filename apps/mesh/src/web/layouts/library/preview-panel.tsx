/**
 * Library file preview panel — right-side panel over the shared FilePreview
 * viewer, mirroring the chat's file tab (toolbar + preview). URL-driven
 * (`?preview=<browse path>`) so a preview link survives reload: the entry
 * is re-resolved via `stat`, not read off list caches.
 *
 * HTML files render the shared HtmlPreviewPanel instead — the SAME single
 * toolbar the chat deck tab shows (URL/copy/open, upgrading with rail/
 * edit/PDF on the deck-viewer handshake), with the Library's download and
 * close actions appended via `trailing`. Only home-volume files get a
 * savePath (the inline editor persists to the home volume).
 */

import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Download01, LinkExternal01, XClose } from "@untitledui/icons";
import {
  FilePreview,
  FilePreviewShimmer,
  formatSize,
} from "@/web/components/file-preview";
import { HtmlPreviewPanel } from "@/web/components/deck/html-preview-panel";
import { FileTypeIcon } from "@/web/components/file-type-icon";
import { useOrgFsDownloadUrl, useOrgFsStat } from "@/web/hooks/use-org-fs";
import { basename, parseLibraryPath } from "./location";

const isHtml = (name: string) => /\.html?$/i.test(name);

function PreviewActions({
  downloadUrl,
  filename,
  onClose,
}: {
  downloadUrl: string;
  filename: string;
  onClose: () => void;
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" asChild>
            <a href={downloadUrl} download={filename}>
              <Download01 size={14} />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Download</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <XClose size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Close</TooltipContent>
      </Tooltip>
    </>
  );
}

export function LibraryPreviewPanel({
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

  // HTML: hand the whole panel (toolbar included) to the shared surface so
  // it is pixel-identical to the chat deck tab.
  if (file && entry && isHtml(filename)) {
    return (
      <HtmlPreviewPanel
        readUrl={file.downloadUrl}
        marker={`${entry.size}-${entry.updatedAt}`}
        title={filename}
        savePath={volume === "home" ? filePath : undefined}
        trailing={
          <PreviewActions
            downloadUrl={file.downloadUrl}
            filename={filename}
            onClose={onClose}
          />
        }
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <FileTypeIcon filename={filename} className="h-4.5 w-3.5 shrink-0" />
          <span className="truncate text-xs font-medium text-foreground">
            {filename}
          </span>
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
              <TooltipContent side="bottom">Open in new tab</TooltipContent>
            </Tooltip>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <XClose size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative min-h-0 flex-1">
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
    </div>
  );
}

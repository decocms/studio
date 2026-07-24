/**
 * FileTab — main-panel preview of a file the thread produced
 * (`?main=file:<encoded key>`).
 *
 * The tab id only carries the output `key`; the file's URL/name/size are
 * resolved from the same `threadOutputs` query the chips and the
 * "Files in this task" panel use, so the server stays the single source
 * of truth for download-URL construction and the three surfaces share one
 * cache entry. Rendering itself is the shared FilePreview component
 * (also used by the Library page).
 */

import { useNavigate } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Download01, LinkExternal01, XClose } from "@untitledui/icons";
import { FileTypeIcon } from "@/components/file-type-icon";
import {
  FilePreview,
  FilePreviewShimmer,
  formatSize,
} from "@/components/file-preview";
import { useT } from "@/i18n/use-t.ts";
import {
  useThreadOutputs,
  type ThreadOutput,
} from "@/components/chat/use-thread-outputs.ts";

function FileToolbar({
  file,
  onClose,
}: {
  file: ThreadOutput;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
        <FileTypeIcon
          filename={file.filename}
          className="h-4.5 w-3.5 shrink-0"
        />
        <span className="truncate text-xs font-medium text-foreground">
          {file.filename}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatSize(file.size)}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" asChild>
            <a href={file.downloadUrl} download={file.filename}>
              <Download01 size={14} />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("mainPanelTabs.fileTab.download")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => window.open(file.downloadUrl, "_blank", "noopener")}
          >
            <LinkExternal01 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("mainPanelTabs.fileTab.openInNewTab")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <XClose size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("mainPanelTabs.fileTab.close")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function FileTab({
  fileKey,
  taskId,
}: {
  fileKey: string;
  taskId: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  // Always enabled while the tab is open — on a fresh page load the
  // message-scan gate (useThreadHasFileWork) may not have hydrated yet,
  // and an open file tab is itself proof the thread produced files.
  const { data: outputs, isPending } = useThreadOutputs(taskId);
  const file = outputs?.find((o) => o.key === fileKey) ?? null;

  const handleClose = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: 0 as const,
      }),
      replace: true,
    });

  if (!file) {
    if (isPending) {
      return (
        <div className="h-full w-full bg-background">
          <FilePreviewShimmer />
        </div>
      );
    }
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background">
        <FileTypeIcon
          filename={fileKey.split("/").pop() ?? fileKey}
          className="h-7.5 w-6"
        />
        <span className="text-sm text-muted-foreground">
          {t("mainPanelTabs.fileTab.fileNotAvailable")}
        </span>
        <Button variant="ghost" size="sm" onClick={handleClose}>
          {t("mainPanelTabs.fileTab.close")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <FileToolbar file={file} onClose={handleClose} />
      <div className="relative min-h-0 flex-1">
        <FilePreview file={file} />
      </div>
    </div>
  );
}

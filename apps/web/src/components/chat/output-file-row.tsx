/**
 * OutputFileRow — one thread-output file: icon, name, hover download,
 * "Open" button → file-preview main-panel tab. Shared by the floating
 * "Files in this task" panel and the per-turn rows under the producing
 * assistant message, so the two surfaces stay visually identical.
 */

import { useT } from "@/i18n/use-t.ts";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import { Download01 } from "@untitledui/icons";
import { FileTypeIcon } from "@/components/file-type-icon";
import { formatFileTabId } from "@/layouts/main-panel-tabs/tab-id";
import type { ThreadOutput } from "./use-thread-outputs.ts";

export function OutputFileRow({ file }: { file: ThreadOutput }) {
  const t = useT();
  const navigate = useNavigate();
  const open = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: formatFileTabId(file.key),
      }),
      replace: true,
    });

  return (
    <div className="group flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
      <FileTypeIcon filename={file.filename} className="h-5 w-4 shrink-0" />
      <button
        type="button"
        onClick={open}
        className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground hover:underline"
        title={file.filename}
      >
        {file.filename}
      </button>
      <a
        href={file.downloadUrl}
        download={file.filename}
        className="hidden shrink-0 text-muted-foreground hover:text-foreground group-hover:block"
        title={t("chat.outputFileRow.download")}
        aria-label={t("chat.outputFileRow.downloadFile", {
          filename: file.filename,
        })}
      >
        <Download01 className="size-3.5" />
      </a>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        onClick={open}
      >
        {t("chat.outputFileRow.open")}
      </Button>
    </div>
  );
}

/** The composer's word on what the agent will see: the page you're on and the
 *  Library file open, each with a way to leave it out of this question. */

import type { ReactNode } from "react";
import { Browser, XClose } from "@untitledui/icons";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AgentAvatar } from "@/components/agent-icon";
import { FileTypeIcon } from "@/components/file-type-icon";
import { useChatViewContext } from "@/hooks/use-current-view";
import { useOpenLibraryFile } from "@/hooks/use-open-library-file";
import { useT } from "@/i18n/use-t.ts";
import { basename } from "@/layouts/library/location";

function ContextChip({
  icon,
  inset,
  label,
  title,
  dismissLabel,
  onDismiss,
}: {
  icon: ReactNode;
  /** The icon carries its own tile, so the chip needs less room before it. */
  inset?: boolean;
  label: string;
  title: string;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  return (
    <span
      className={cn(
        "surface-inset flex h-7 min-w-0 items-center gap-1.5 rounded-full pr-0.5 text-xs text-foreground",
        inset ? "pl-1" : "pl-2.5",
      )}
      title={title}
    >
      {icon}
      <span className="truncate">{label}</span>
      <IconButton label={dismissLabel} size="icon-sm" onClick={onDismiss}>
        <XClose size={12} />
      </IconButton>
    </span>
  );
}

export function ContextChips() {
  const t = useT();
  const view = useChatViewContext();
  const openFile = useOpenLibraryFile();
  if (!view && !openFile) return null;
  const viewLabel = view
    ? view.project && !view.isHome
      ? `${view.project.title} · ${view.title}`
      : view.title
    : "";
  const fileName = openFile ? basename(openFile.path) : "";
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5 px-3 pt-3">
      {view && (
        <ContextChip
          icon={
            view.project ? (
              <AgentAvatar
                icon={(view.project.icon as string | null | undefined) ?? null}
                name={view.project.title}
                size="xs"
              />
            ) : (
              <Browser size={14} className="shrink-0 text-muted-foreground" />
            )
          }
          inset={!!view.project}
          label={viewLabel}
          title={t("chat.input.viewContext", { name: viewLabel })}
          dismissLabel={t("chat.input.viewDismiss")}
          onDismiss={view.dismiss}
        />
      )}
      {openFile && (
        <ContextChip
          icon={
            <FileTypeIcon filename={fileName} className="h-4 w-3 shrink-0" />
          }
          label={fileName}
          title={t("chat.input.openFileContext", { name: fileName })}
          dismissLabel={t("chat.input.openFileDismiss")}
          onDismiss={openFile.dismiss}
        />
      )}
    </div>
  );
}

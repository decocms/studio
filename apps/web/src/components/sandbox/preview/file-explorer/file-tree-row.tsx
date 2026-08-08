import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@decocms/ui/components/context-menu.tsx";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Loading01,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TreeNode } from "./types";
import type { FileIcon } from "./utils";

const FOLDER_COLOR = "#d9a441";

export function FileTreeRow({
  node,
  depth,
  isExpanded,
  isSelected,
  isLoading = false,
  fileVisual,
  onOpen,
  onSelect,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onCopyRelativePath,
  onRename,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isLoading?: boolean;
  fileVisual: { Icon: FileIcon; color: string };
  onOpen: () => void;
  onSelect: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const isDir = node.kind === "directory";
  const { Icon: FileVisualIcon, color: fileColor } = fileVisual;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[13px] hover:bg-accent transition-colors",
            isSelected && "bg-accent",
          )}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => {
            onSelect();
            onOpen();
          }}
        >
          {isDir ? (
            <>
              {isLoading ? (
                <Loading01
                  size={14}
                  className="shrink-0 animate-spin text-muted-foreground"
                />
              ) : isExpanded ? (
                <ChevronDown
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
              ) : (
                <ChevronRight
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
              )}
              <Folder
                size={16}
                className="shrink-0"
                style={{ color: FOLDER_COLOR }}
              />
            </>
          ) : (
            <>
              <span className="w-3.5 shrink-0" />
              <FileVisualIcon
                size={16}
                className="shrink-0"
                style={{ color: fileColor }}
              />
            </>
          )}
          <span className="truncate">{node.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onNewFile}>
          {t("sandbox.fileTreeRow.newFile")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onNewFolder}>
          {t("sandbox.fileTreeRow.newFolder")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCopyPath}>
          {t("sandbox.fileTreeRow.copyPath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopyRelativePath}>
          {t("sandbox.fileTreeRow.copyRelativePath")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRename}>
          {t("sandbox.fileTreeRow.rename")}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          {t("sandbox.fileTreeRow.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

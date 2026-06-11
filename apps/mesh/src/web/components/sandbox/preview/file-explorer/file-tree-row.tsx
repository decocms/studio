import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@deco/ui/components/context-menu.tsx";
import { ChevronDown, ChevronRight, Folder } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";
import type { TreeNode } from "./types";

type FileIcon = React.ComponentType<{
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}>;

const FOLDER_COLOR = "#d9a441";

export function FileTreeRow({
  node,
  depth,
  isExpanded,
  isSelected,
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
              {isExpanded ? (
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
        <ContextMenuItem onSelect={onNewFile}>New File</ContextMenuItem>
        <ContextMenuItem onSelect={onNewFolder}>New Folder</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCopyPath}>Copy Path</ContextMenuItem>
        <ContextMenuItem onSelect={onCopyRelativePath}>
          Copy Relative Path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRename}>Rename</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

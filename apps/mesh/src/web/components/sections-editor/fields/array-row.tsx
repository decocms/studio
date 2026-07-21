import {
  Copy01,
  DotsGrid,
  DotsHorizontal,
  Eye,
  EyeOff,
  Trash01,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export function ArrayRowContent({
  labelText,
  imageSrc,
}: {
  labelText: string;
  imageSrc?: string;
}) {
  return (
    <>
      <DotsGrid className="size-3.5 shrink-0 text-muted-foreground/40" />
      <div className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
        {imageSrc && (
          <img
            src={imageSrc}
            alt=""
            referrerPolicy="no-referrer"
            className="h-12 max-w-[100px] shrink-0 rounded object-cover"
          />
        )}
        <span className="min-w-0 truncate">{labelText}</span>
      </div>
    </>
  );
}

export function SortableArrayRow({
  sortableId,
  labelText,
  imageSrc,
  hidden,
  onToggleHidden,
  onOpen,
  onDuplicate,
  onRemove,
}: {
  sortableId: string;
  labelText: string;
  imageSrc?: string;
  hidden?: boolean;
  onToggleHidden?: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useSortable({
      id: sortableId,
      animateLayoutChanges: () => false,
    });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, x: 0 } : null,
    ),
    opacity: isDragging ? 0 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-accent hover:text-accent-foreground touch-none",
        isDragging ? "cursor-grabbing" : "cursor-pointer",
      )}
      title={labelText}
    >
      <DotsGrid className="size-3.5 shrink-0 text-muted-foreground/40" />
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          referrerPolicy="no-referrer"
          className="h-12 max-w-[100px] shrink-0 rounded object-cover"
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          hidden && "line-through opacity-50",
        )}
      >
        {labelText}
      </span>
      {onToggleHidden && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={hidden ? "Show item" : "Hide item"}
              className={cn(
                "size-6 shrink-0",
                hidden
                  ? "opacity-100"
                  : "opacity-0 transition-opacity group-hover:opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onToggleHidden();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {hidden ? "Show item" : "Hide item"}
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Open actions for ${labelText}`}
            className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <DotsHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onDuplicate}>
            <Copy01 size={14} />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onRemove}
          >
            <Trash01 size={14} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

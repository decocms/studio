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

// Width/margin snap instantly (no visible slide) while opacity does the
// actual animating. On reveal the snap has no delay, so the button is
// already full-size before opacity starts rising. On hide the snap is
// delayed until the fade-out finishes, so it's invisible when it happens.
//
// This button is toggled on (hidden) — always shown, no hover dependency.
const ACTION_BUTTON_SHOWN =
  "w-6 ml-0 opacity-100 [transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]";
// No button on this row is toggled on — everyone starts fully collapsed
// (zero width) so the label gets the space, and hover reveals the whole
// group. group-has-[:focus-visible] (not group-focus-within) so keyboard
// Tab reveals it too, without a mouse click sticking it open (clicking a
// <button> focuses it, but doesn't count as :focus-visible).
const ACTION_BUTTON_HIDDEN =
  "w-0 -ml-2 opacity-0 [transition:opacity_150ms_ease-out,width_0ms_150ms,margin-left_0ms_150ms] " +
  "group-hover:ml-0 group-hover:w-6 group-hover:opacity-100 group-hover:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms] " +
  "group-has-[:focus-visible]:ml-0 group-has-[:focus-visible]:w-6 group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]";
// A sibling button on this row IS toggled on, so the whole action-button
// group already reserves its width — this button just isn't the active
// one. Stay at full width and only fade opacity, so a sibling toggling on
// or off never shifts this button (or the label) horizontally.
const ACTION_BUTTON_RESERVED_HIDDEN =
  "w-6 ml-0 opacity-0 [transition:opacity_150ms_ease-out,width_0ms_150ms,margin-left_0ms_150ms] " +
  "group-hover:opacity-100 group-has-[:focus-visible]:opacity-100";

// `reserved`: true when ANY button on this row is toggled on, so the whole
// group keeps its reserved width even for the buttons that aren't
// themselves active. `active`: this specific button is toggled on.
function actionButtonVisibilityClass(reserved: boolean, active: boolean) {
  return cn(
    "h-6 shrink-0 overflow-hidden",
    active
      ? ACTION_BUTTON_SHOWN
      : reserved
        ? ACTION_BUTTON_RESERVED_HIDDEN
        : ACTION_BUTTON_HIDDEN,
  );
}

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
                actionButtonVisibilityClass(hidden === true, hidden === true),
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
            className={cn(
              actionButtonVisibilityClass(hidden === true, false),
              "data-[state=open]:ml-0 data-[state=open]:w-6 data-[state=open]:opacity-100 data-[state=open]:[transition:opacity_150ms_ease-out,width_0ms,margin-left_0ms]",
            )}
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

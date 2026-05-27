import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  Copy01,
  DotsHorizontal,
  LayoutAlt01,
  Trash01,
} from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.js";

const VARIANT_ICON_COLOR = "oklch(0.65 0.15 160)";
const VARIANT_ROW_CLASS =
  "text-[oklch(0.45_0.15_160)] hover:bg-[oklch(0.65_0.15_160/0.12)] dark:text-[oklch(0.78_0.15_160)] dark:hover:bg-[oklch(0.65_0.15_160/0.15)]";
const VARIANT_SELECTED_ROW_CLASS =
  "text-[oklch(0.45_0.15_160)] bg-[oklch(0.65_0.15_160/0.18)] dark:text-[oklch(0.78_0.15_160)] dark:bg-[oklch(0.65_0.15_160/0.2)]";

export interface SectionVariantEntry {
  index: number;
  label: string;
}

function VariantRow({
  variant,
  selected,
  canDelete,
  onSelect,
  onDuplicate,
  onDelete,
}: {
  variant: SectionVariantEntry;
  selected: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex select-none items-center gap-2 rounded-md px-2 py-2.5 transition-colors cursor-pointer",
        selected ? VARIANT_SELECTED_ROW_CLASS : VARIANT_ROW_CLASS,
      )}
    >
      <LayoutAlt01
        className="h-4 w-4 shrink-0"
        style={{ color: VARIANT_ICON_COLOR }}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {variant.label}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Open actions for ${variant.label}`}
            className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <DotsHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
          >
            <Copy01 size={14} />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={!canDelete}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash01 size={14} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function SectionVariantList({
  variants,
  selectedIndex,
  onSelect,
  onDuplicate,
  onDelete,
  onRemoveAll,
}: {
  variants: SectionVariantEntry[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onRemoveAll: () => void;
}) {
  const canDelete = variants.length > 1;

  return (
    <div className="space-y-1 border-b p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Variants
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove all variants"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={onRemoveAll}
            >
              <Trash01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove all variants</TooltipContent>
        </Tooltip>
      </div>
      <div className="space-y-0.5">
        {variants.map((variant) => (
          <VariantRow
            key={`${variant.label}-${variant.index}`}
            variant={variant}
            selected={variant.index === selectedIndex}
            canDelete={canDelete}
            onSelect={() => onSelect(variant.index)}
            onDuplicate={() => onDuplicate(variant.index)}
            onDelete={() => onDelete(variant.index)}
          />
        ))}
      </div>
    </div>
  );
}

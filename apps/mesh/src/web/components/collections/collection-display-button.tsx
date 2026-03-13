import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Sliders01, Check, ArrowUp, ArrowDown } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

export interface FilterGroup {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ id: string; label: string }>;
}

interface CollectionDisplayButtonProps {
  sortKey?: string;
  sortDirection?: "asc" | "desc" | null;
  onSort?: (key: string) => void;
  sortOptions?: Array<{ id: string; label: string }>;
  filters?: FilterGroup[];
}

export function CollectionDisplayButton({
  sortKey,
  sortDirection,
  onSort,
  sortOptions = [],
  filters = [],
}: CollectionDisplayButtonProps) {
  const activeFilterCount = filters.filter((f) => f.value !== "ALL").length;

  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="size-7 border border-input relative"
              >
                <Sliders01 size={16} />
                {activeFilterCount > 0 && (
                  <Badge
                    variant="default"
                    className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 text-[10px] leading-none"
                  >
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Display &amp; filters</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" className="w-[200px] p-0 gap-0">
        {/* Sort Options */}
        {sortOptions.length > 0 && onSort && (
          <div className="p-1 flex flex-col gap-0.5 border-b border-border">
            <div className="px-2 py-1.5 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
              Sort by
            </div>
            {sortOptions.map((option) => {
              const isSelected = sortKey === option.id;
              return (
                <DropdownMenuItem
                  key={option.id}
                  onClick={() => onSort(option.id)}
                  className={cn(
                    "h-8 px-2 py-0 cursor-pointer",
                    isSelected && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-2 w-full">
                    {isSelected && (
                      <Check size={16} className="text-foreground shrink-0" />
                    )}
                    {!isSelected && <div className="w-4 shrink-0" />}
                    <span className="text-sm text-foreground flex-1">
                      {option.label}
                    </span>
                    {isSelected &&
                      sortDirection &&
                      (sortDirection === "asc" ? (
                        <ArrowUp
                          size={16}
                          className="text-foreground shrink-0"
                        />
                      ) : (
                        <ArrowDown
                          size={16}
                          className="text-foreground shrink-0"
                        />
                      ))}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </div>
        )}

        {/* Filter Groups */}
        {filters.map((filter) => (
          <div
            key={filter.label}
            className="p-1 flex flex-col gap-0.5 border-b border-border last:border-b-0"
          >
            <div className="px-2 py-1.5 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
              {filter.label}
            </div>
            {filter.options.map((option) => {
              const isSelected = filter.value === option.id;
              return (
                <DropdownMenuItem
                  key={option.id}
                  onClick={() => filter.onChange(option.id)}
                  className={cn(
                    "h-8 px-2 py-0 cursor-pointer",
                    isSelected && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-2 w-full">
                    {isSelected && (
                      <Check size={16} className="text-foreground shrink-0" />
                    )}
                    {!isSelected && <div className="w-4 shrink-0" />}
                    <span className="text-sm text-foreground flex-1">
                      {option.label}
                    </span>
                  </div>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

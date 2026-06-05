import { useState } from "react";
import { Plus } from "@untitledui/icons";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { BlogBlockType } from "./blog-data";

/**
 * The WordPress-style "insert here" affordance: a thin hover zone with a
 * centered ⊕ that opens a searchable block-type picker and inserts at
 * this position. Always visible (not just on hover) when `alwaysShow`.
 */
export function InsertBlockDivider({
  blockTypes,
  onInsert,
  alwaysShow = false,
}: {
  blockTypes: BlogBlockType[];
  onInsert: (resolveType: string) => void;
  alwaysShow?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={cn(
        "group/insert relative flex h-6 items-center justify-center",
        alwaysShow ? "h-10" : "",
      )}
    >
      <div
        className={cn(
          "absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-opacity",
          open || alwaysShow
            ? "opacity-100"
            : "opacity-0 group-hover/insert:opacity-100",
        )}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Insert block"
            className={cn(
              "relative z-10 flex h-6 w-6 items-center justify-center rounded-full border bg-background text-muted-foreground transition-all hover:border-primary hover:text-primary cursor-pointer",
              open || alwaysShow
                ? "opacity-100"
                : "opacity-0 group-hover/insert:opacity-100",
            )}
          >
            <Plus size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="center">
          <Command>
            <CommandInput placeholder="Search blocks…" />
            <CommandList>
              <CommandEmpty>No blocks found.</CommandEmpty>
              <CommandGroup>
                {blockTypes.map((type) => (
                  <CommandItem
                    key={type.resolveType}
                    value={`${type.title} ${type.resolveType}`}
                    onSelect={() => {
                      onInsert(type.resolveType);
                      setOpen(false);
                    }}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="text-sm font-medium">{type.title}</span>
                    {type.description && (
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {type.description}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

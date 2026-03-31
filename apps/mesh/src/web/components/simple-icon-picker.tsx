/**
 * Simple Icon Picker
 *
 * A lightweight icon-only picker — no color selection, no upload, no tabs.
 * Shows a searchable grid of @untitledui/icons in a popover.
 * Stores the selection as "icon://<Name>" (no color).
 */

import { Input } from "@deco/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { LayoutLeft, SearchMd } from "@untitledui/icons";
import { useState } from "react";
import {
  getIconComponent,
  getIconNames,
  humanizeIconName,
  parseIconString,
} from "./agent-icon";

interface SimpleIconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string) => void;
  className?: string;
  disabled?: boolean;
}

function CurrentIcon({ value }: { value: string | null | undefined }) {
  const parsed = parseIconString(value);
  if (parsed.type === "icon") {
    const IconComp = getIconComponent(parsed.name);
    if (IconComp) {
      return <IconComp size={16} className="text-muted-foreground" />;
    }
  }
  return <LayoutLeft size={16} className="text-muted-foreground" />;
}

export function SimpleIconPicker({
  value,
  onChange,
  className,
  disabled,
}: SimpleIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const parsed = parseIconString(value);
  const currentIconName = parsed.type === "icon" ? parsed.name : null;

  const allNames = getIconNames();
  const filteredNames = search.trim()
    ? allNames.filter((n) => {
        const searchLower = search.toLowerCase();
        return (
          humanizeIconName(n).includes(searchLower) ||
          n.toLowerCase().includes(searchLower)
        );
      })
    : allNames;

  return (
    <Popover open={disabled ? false : open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "size-7 shrink-0 rounded-md transition-colors flex items-center justify-center",
            disabled
              ? "cursor-default opacity-50"
              : "cursor-pointer hover:bg-accent",
            className,
          )}
        >
          <CurrentIcon value={value} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          <div className="px-2 py-2">
            <div className="relative">
              <SearchMd
                size={14}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter..."
                className="h-7 text-xs pl-7"
              />
            </div>
          </div>
          <ScrollArea className="h-48">
            <div className="grid grid-cols-8 gap-0.5 px-2 pb-2">
              {filteredNames.map((iconName) => {
                const IconComp = getIconComponent(iconName);
                if (!IconComp) return null;
                return (
                  <button
                    key={iconName}
                    type="button"
                    onClick={() => {
                      onChange(`icon://${iconName}`);
                      setOpen(false);
                    }}
                    className={cn(
                      "h-7 w-7 flex items-center justify-center rounded-md transition-colors cursor-pointer",
                      currentIconName === iconName
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    title={humanizeIconName(iconName)}
                  >
                    <IconComp size={16} />
                  </button>
                );
              })}
            </div>
            {filteredNames.length === 0 && (
              <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                No icons found
              </div>
            )}
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

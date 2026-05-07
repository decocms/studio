/**
 * "Add tile" sheet — a categorised catalog of tile types the user can
 * drop onto their board. New tiles land at the first empty grid slot
 * (top-most, left-most) and the sheet closes once one is added.
 *
 * The catalog is static for now (`TILE_CATALOG` from registry.tsx);
 * once MCP apps contribute their own tile types this becomes a hook.
 */

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { SearchMd } from "@untitledui/icons";
import { useState } from "react";
import { CATEGORY_LABELS, CATEGORY_ORDER, TILE_CATALOG } from "./registry";
import { SIZE_PRESETS } from "./constants";
import type { TileDefinition, TileInstance } from "./types";

function newTileId(): string {
  return `tile_${Math.random().toString(36).slice(2, 10)}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (tile: Omit<TileInstance, "x" | "y">) => void;
}

export function TileAddSheet({ open, onOpenChange, onAdd }: Props) {
  const [query, setQuery] = useState("");

  const lower = query.trim().toLowerCase();
  const filtered = TILE_CATALOG.filter((d) => {
    if (!lower) return true;
    return (
      d.title.toLowerCase().includes(lower) ||
      d.description.toLowerCase().includes(lower) ||
      d.type.toLowerCase().includes(lower)
    );
  });

  const grouped = new Map<string, TileDefinition[]>();
  for (const cat of CATEGORY_ORDER) grouped.set(cat, []);
  for (const def of filtered) {
    grouped.get(def.category)?.push(def);
  }

  const handleAdd = (def: TileDefinition) => {
    const size = SIZE_PRESETS[def.defaultSize];
    onAdd({
      id: newTileId(),
      type: def.type,
      w: size.w,
      h: size.h,
      config: {},
    });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 gap-0 flex flex-col">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle>Add a tile</SheetTitle>
          <SheetDescription>
            Pick something to pin to your home. Tiles ship with the app today;
            agents and MCP apps will add their own next.
          </SheetDescription>
          <div className="relative mt-2">
            <SearchMd
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tiles…"
              className="pl-8"
            />
          </div>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-6 p-4">
            {CATEGORY_ORDER.map((cat) => {
              const items = grouped.get(cat) ?? [];
              if (items.length === 0) return null;
              return (
                <section key={cat} className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {CATEGORY_LABELS[cat]}
                  </h3>
                  <ul className="grid grid-cols-1 gap-2">
                    {items.map((def) => (
                      <li key={def.type}>
                        <button
                          type="button"
                          onClick={() => handleAdd(def)}
                          className="flex w-full items-start gap-3 rounded-lg border border-border bg-background p-3 hover:bg-muted hover:border-primary/30 transition-colors text-left"
                        >
                          <span className="flex size-8 items-center justify-center rounded-md bg-muted text-foreground shrink-0">
                            {def.icon}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground truncate">
                                {def.title}
                              </span>
                              {def.source !== "system" && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] h-4 px-1.5 font-normal capitalize"
                                >
                                  {def.source}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {def.description}
                            </p>
                          </div>
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wide shrink-0 mt-1">
                            {def.defaultSize}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {filtered.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-12">
                No tiles match "{query}".
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

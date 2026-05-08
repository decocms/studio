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
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
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

const SOURCE_LABEL: Record<string, string> = {
  agent: "Agent",
  mcp: "MCP",
  system: "System",
};

const SOURCE_TONE: Record<string, string> = {
  agent: "bg-primary/10 text-primary",
  mcp: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  system: "bg-muted text-muted-foreground",
};

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
      config: def.defaultConfig ? { ...def.defaultConfig } : {},
    });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 gap-0 flex flex-col">
        <SheetHeader className="border-b border-border px-5 py-4 shrink-0 gap-3">
          <div className="flex flex-col gap-1">
            <SheetTitle className="text-base">Add a tile</SheetTitle>
            <SheetDescription className="text-xs">
              Pin agents, dashboards, and notes to your home.
            </SheetDescription>
          </div>
          <div className="relative">
            <SearchMd
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tiles…"
              className="pl-9 h-9"
            />
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-7 px-5 py-5 pb-10">
              {CATEGORY_ORDER.map((cat) => {
                const items = grouped.get(cat) ?? [];
                if (items.length === 0) return null;
                return (
                  <section key={cat} className="flex flex-col gap-3">
                    <div className="flex items-baseline justify-between">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {CATEGORY_LABELS[cat]}
                      </h3>
                      <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                        {items.length}
                      </span>
                    </div>
                    <ul className="grid grid-cols-1 gap-2">
                      {items.map((def) => (
                        <li key={def.type}>
                          <CatalogRow def={def} onAdd={handleAdd} />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {filtered.length === 0 && (
                <div className="text-center text-sm text-muted-foreground py-16">
                  No tiles match "{query}".
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CatalogRow({
  def,
  onAdd,
}: {
  def: TileDefinition;
  onAdd: (def: TileDefinition) => void;
}) {
  const sourceTone = SOURCE_TONE[def.source] ?? SOURCE_TONE.system!;
  const sourceLabel = SOURCE_LABEL[def.source] ?? "System";
  const config = def.defaultConfig as
    | { icon?: string; description?: string }
    | undefined;
  const previewIcon = config?.icon;

  return (
    <button
      type="button"
      onClick={() => onAdd(def)}
      className="group flex w-full items-start gap-3 rounded-xl border border-border/60 bg-background p-3.5 hover:bg-muted/40 hover:border-primary/40 transition-colors text-left"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-muted/60 text-foreground shrink-0 overflow-hidden border border-border/60">
        {previewIcon ? (
          <img
            src={
              previewIcon.startsWith("/") || previewIcon.startsWith("http")
                ? previewIcon
                : ""
            }
            alt=""
            aria-hidden
            className="size-5 object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          def.icon
        )}
      </span>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-foreground truncate tracking-tight">
            {def.title}
          </span>
          {def.source !== "system" && (
            <span
              className={cn(
                "text-[10px] h-4 px-1.5 rounded-full inline-flex items-center font-medium",
                sourceTone,
              )}
            >
              {sourceLabel}
            </span>
          )}
        </div>
        <p className="text-[12px] text-muted-foreground line-clamp-2 leading-snug">
          {def.description}
        </p>
      </div>
      <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide shrink-0 mt-0.5 tabular-nums">
        {def.defaultSize}
      </span>
    </button>
  );
}

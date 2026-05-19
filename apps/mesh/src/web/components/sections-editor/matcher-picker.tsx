import { useState } from "react";
import { ChevronDown } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@deco/ui/components/command.tsx";
import type { LiveMeta } from "./resolve-schema";

export interface MatcherEntry {
  resolveType: string;
  title: string;
  description?: string;
}

/**
 * Extract the list of available matcher block types from live meta.
 * Looks for block-type keys that contain "matchers" (e.g. "matchers",
 * "website/matchers") and collects each entry's resolveType + title.
 */
export function extractMatchers(meta: LiveMeta): MatcherEntry[] {
  const blocks = meta.manifest?.blocks ?? {};
  const result: MatcherEntry[] = [];
  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes("matchers")) continue;
    for (const resolveType of Object.keys(blockMap)) {
      // Skip "always" and "never" — always is hardcoded, never isn't user-selectable
      if (resolveType.includes("always") || resolveType.includes("never"))
        continue;
      const segments = resolveType.split("/");
      const filename = segments[segments.length - 1] ?? resolveType;
      const title = filename
        .replace(/\.(tsx?|jsx?)$/, "")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      result.push({ resolveType, title });
    }
  }
  return result;
}

/**
 * A button + CommandDialog that lets users pick a matcher type for a variant rule.
 */
export function MatcherPicker({
  currentRt,
  currentLabel,
  matchers,
  onSelect,
}: {
  currentRt: string;
  currentLabel: string;
  matchers: MatcherEntry[];
  onSelect: (resolveType: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const handleSelect = (rt: string) => {
    onSelect(rt);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs transition-colors hover:bg-accent/40"
      >
        <span className="flex-1 truncate">{currentLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Choose a rule"
        description="Pick how to target users for this variant"
        className="sm:max-w-lg"
      >
        <CommandInput placeholder="Search rules..." />
        <CommandList>
          <CommandEmpty>No rules found.</CommandEmpty>
          <CommandGroup>
            <CommandItem
              value="always Target all users"
              onSelect={() => handleSelect("")}
              className={cn("gap-2.5", !currentRt && "bg-accent/60")}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm">Always</span>
                <span className="text-xs text-muted-foreground">
                  Target all users
                </span>
              </div>
            </CommandItem>
            {matchers.map((m) => (
              <CommandItem
                key={m.resolveType}
                value={`${m.title} ${m.resolveType} ${m.description ?? ""}`}
                onSelect={() => handleSelect(m.resolveType)}
                className={cn(
                  "gap-2.5",
                  currentRt === m.resolveType && "bg-accent/60",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm">{m.title}</span>
                  {m.description && (
                    <span className="truncate text-xs text-muted-foreground">
                      {m.description}
                    </span>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

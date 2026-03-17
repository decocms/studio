import { useState } from "react";
import type { ConnectionCreateData } from "@/tools/connection/schema";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Check, ChevronDown, Plus } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

interface Registry {
  id: string;
  name: string;
  icon?: string;
}

interface StoreRegistrySelectProps {
  registries: Registry[];
  value: string;
  onValueChange: (value: string) => void;
  onAddWellKnown: (registry: ConnectionCreateData) => void;
  onAddGitHubRepo?: () => void;
  wellKnownRegistries: ConnectionCreateData[];
  placeholder?: string;
}

export function StoreRegistrySelect({
  registries,
  value,
  onValueChange,
  onAddWellKnown,
  onAddGitHubRepo,
  wellKnownRegistries,
  placeholder = "Select a registry...",
}: StoreRegistrySelectProps) {
  const [open, setOpen] = useState(false);

  const selected = registries.find((r) => r.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-lg border bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-[color,box-shadow] outline-none focus-visible:ring-[3px] h-7 min-w-[160px]",
          )}
        >
          {selected ? (
            <span className="flex items-center gap-2">
              {selected.icon ? (
                <img
                  src={selected.icon}
                  alt={selected.name}
                  className="w-4 h-4 rounded"
                />
              ) : (
                <span className="w-4 h-4 rounded from-primary/20 to-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                  {selected.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span>{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronDown className="size-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto min-w-[200px] p-1">
        {registries.map((registry) => (
          <button
            type="button"
            key={registry.id ?? registry.name}
            onClick={() => {
              onValueChange(registry.id ?? registry.name);
              setOpen(false);
            }}
            className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
          >
            <div className="flex items-center gap-2">
              {registry.icon ? (
                <img
                  src={registry.icon}
                  alt={registry.name}
                  className="w-4 h-4 rounded"
                />
              ) : (
                <span className="w-4 h-4 rounded from-primary/20 to-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                  {registry.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span>{registry.name}</span>
            </div>
            {value === (registry.id ?? registry.name) && (
              <span className="absolute right-2 flex size-3.5 items-center justify-center">
                <Check className="size-4" />
              </span>
            )}
          </button>
        ))}
        {wellKnownRegistries.length > 0 && (
          <div className="border-t border-border pt-1 mt-1">
            <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Other known registries
            </p>
            {wellKnownRegistries.map((registry) => (
              <button
                type="button"
                onClick={() => {
                  onAddWellKnown(registry);
                  setOpen(false);
                }}
                key={registry.id ?? registry.title}
                className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
              >
                <div className="flex items-center gap-2">
                  {registry.icon ? (
                    <img
                      src={registry.icon}
                      alt={registry.title}
                      className="w-4 h-4 rounded"
                    />
                  ) : (
                    <span className="w-4 h-4 rounded bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                      {registry.title.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="flex-1">{registry.title}</span>
                </div>
                <span className="absolute right-2 flex size-3.5 items-center justify-center text-muted-foreground">
                  <Plus size={16} />
                </span>
              </button>
            ))}
          </div>
        )}
        {onAddGitHubRepo && (
          <div className="border-t border-border pt-1 mt-1">
            <button
              type="button"
              onClick={() => {
                onAddGitHubRepo();
                setOpen(false);
              }}
              className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
            >
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                  +
                </span>
                <span className="flex-1">Add GitHub Repository...</span>
              </div>
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

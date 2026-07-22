import { useState } from "react";
import { Box, Plus } from "@untitledui/icons";
import type { ComponentType, SVGProps } from "react";
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
import { getIconComponent } from "@/web/components/agent-icon";
import { useT } from "@/web/i18n/use-t.ts";
import type { BlogBlockSource, BlogBlockType } from "./blog-data";

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

type GroupLabelKey = Record<
  BlogBlockSource,
  "sandbox.blockPicker.blocksLabel" | "sandbox.blockPicker.customBlocksLabel"
>;

const GROUP_LABEL_KEYS: GroupLabelKey = {
  app: "sandbox.blockPicker.blocksLabel",
  site: "sandbox.blockPicker.customBlocksLabel",
};

function BlockIcon({
  iconName,
  iconUrl,
  alt,
}: {
  iconName: string;
  iconUrl?: string;
  alt: string;
}) {
  const Icon: IconComponent = getIconComponent(iconName) ?? Box;
  return (
    <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
      {iconUrl ? (
        <img src={iconUrl} alt={alt} className="size-5 object-contain" />
      ) : (
        <Icon size={16} className="text-muted-foreground" />
      )}
    </div>
  );
}

function BlockItem({
  type,
  onInsert,
}: {
  type: BlogBlockType;
  onInsert: (resolveType: string) => void;
}) {
  return (
    <CommandItem
      value={`${type.title} ${type.resolveType} ${type.description ?? ""}`}
      onSelect={() => onInsert(type.resolveType)}
      className="flex items-center gap-2.5"
    >
      <BlockIcon
        iconName={type.iconName}
        iconUrl={type.iconUrl}
        alt={type.title}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{type.title}</span>
        {type.description && (
          <span className="truncate text-xs text-muted-foreground">
            {type.description}
          </span>
        )}
      </div>
    </CommandItem>
  );
}

/**
 * The WordPress-style "insert here" affordance: a thin divider with a
 * centered ⊕ that opens a searchable block-type picker and inserts at
 * this position. Always visible so authors never have to hover-hunt for it;
 * `alwaysShow` only enlarges the hit area for the empty-document case.
 *
 * Blocks are grouped by source: built-ins from the `deco-cms/blog` app
 * under "Blocks", and site-defined sections (`site/sections/Blog/Post/*`)
 * under "Custom blocks". If only one source is present the heading is
 * omitted to keep the picker compact.
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
  const t = useT();
  const [open, setOpen] = useState(false);

  const appBlocks: BlogBlockType[] = [];
  const siteBlocks: BlogBlockType[] = [];
  for (const type of blockTypes) {
    (type.source === "site" ? siteBlocks : appBlocks).push(type);
  }

  const handleInsert = (resolveType: string) => {
    onInsert(resolveType);
    setOpen(false);
  };

  // Only label groups when both are present — a lone group with a heading
  // looks heavy in a narrow popover.
  const showHeadings = appBlocks.length > 0 && siteBlocks.length > 0;

  return (
    <div
      className={cn(
        "group/insert relative flex h-6 items-center justify-center",
        alwaysShow ? "h-10" : "",
      )}
    >
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("sandbox.blockPicker.insertBlockButton")}
            className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full border bg-background text-muted-foreground transition-all hover:border-primary hover:text-primary cursor-pointer"
          >
            <Plus size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="center">
          <Command>
            <CommandInput
              placeholder={t("sandbox.blockPicker.searchPlaceholder")}
            />
            <CommandList className="max-h-80">
              <CommandEmpty>
                {t("sandbox.blockPicker.noBlocksFound")}
              </CommandEmpty>
              {siteBlocks.length > 0 && (
                <CommandGroup
                  heading={showHeadings ? t(GROUP_LABEL_KEYS.site) : undefined}
                >
                  {siteBlocks.map((type) => (
                    <BlockItem
                      key={type.resolveType}
                      type={type}
                      onInsert={handleInsert}
                    />
                  ))}
                </CommandGroup>
              )}
              {appBlocks.length > 0 && (
                <CommandGroup
                  heading={showHeadings ? t(GROUP_LABEL_KEYS.app) : undefined}
                >
                  {appBlocks.map((type) => (
                    <BlockItem
                      key={type.resolveType}
                      type={type}
                      onInsert={handleInsert}
                    />
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

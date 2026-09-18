import { useState } from "react";
import { Box } from "@untitledui/icons";
import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { getIconComponent } from "@/components/agent-icon";
import { useT } from "@/i18n/use-t.ts";
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

/** Searchable block-type picker around a caller-supplied `children` trigger, grouped by source. */
export function BlockPicker({
  blockTypes,
  onInsert,
  children,
  align = "start",
}: {
  blockTypes: BlogBlockType[];
  onInsert: (resolveType: string) => void;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Portal into the open dialog (if any) so wheel-scroll survives its scroll lock.
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (next && typeof document !== "undefined") {
      setContainer(
        document.querySelector<HTMLElement>(
          '[data-slot="dialog-content"][data-state="open"]',
        ),
      );
    }
    setOpen(next);
  };

  const appBlocks: BlogBlockType[] = [];
  const siteBlocks: BlogBlockType[] = [];
  for (const type of blockTypes) {
    (type.source === "site" ? siteBlocks : appBlocks).push(type);
  }

  const handleInsert = (resolveType: string) => {
    onInsert(resolveType);
    setOpen(false);
  };

  const showHeadings = appBlocks.length > 0 && siteBlocks.length > 0;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        container={container ?? undefined}
        className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col p-0"
        align={align}
      >
        <Command className="min-h-0 flex-1">
          <CommandInput
            placeholder={t("sandbox.blockPicker.searchPlaceholder")}
          />
          <CommandList className="min-h-0 flex-1">
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
  );
}

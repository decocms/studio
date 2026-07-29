import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import { Check, Plus, Trash03 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { tagDotColor, type OrgTag } from "./config";

export function TagPickerContent({
  tags,
  selectedIds,
  defaultColor,
  onToggle,
  onCreate,
  onDelete,
}: {
  tags: OrgTag[];
  selectedIds: string[];
  /** Hex color the create row starts on; the user can change it to any other. */
  defaultColor: string;
  onToggle: (tagId: string) => void;
  /** Create a new org tag and select it. Resolves once created. */
  onCreate: (name: string, color: string) => Promise<void>;
  /** Delete the org tag entirely (removed from every task/member that had it). */
  onDelete: (tagId: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [color, setColor] = useState(defaultColor);

  const trimmed = search.trim();
  const exactMatch = tags.some(
    (tag) => tag.name.toLowerCase() === trimmed.toLowerCase(),
  );

  const create = async () => {
    if (!trimmed || exactMatch || creating) return;
    setCreating(true);
    try {
      await onCreate(trimmed, color);
      setSearch("");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Command>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={t("taskBoard.taskDialog.tagFilterPlaceholder")}
        className="h-9"
      />
      <CommandList>
        {trimmed && !exactMatch ? (
          <CommandGroup>
            <div className="flex items-center gap-1">
              {/* Native color input — any hex, no palette to maintain. */}
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label={t("taskBoard.taskDialog.pickTagColorAriaLabel")}
                className="ml-2 size-4 shrink-0 cursor-pointer appearance-none rounded-full border-0 bg-transparent p-0 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
              />
              <CommandItem
                value={`create-${trimmed}`}
                disabled={creating}
                onSelect={create}
                className="flex-1 gap-2"
              >
                <Plus size={16} className="text-muted-foreground" />
                <span className="truncate">
                  {t("taskBoard.taskDialog.createTagOption", { name: trimmed })}
                </span>
              </CommandItem>
            </div>
          </CommandGroup>
        ) : (
          <CommandEmpty>{t("taskBoard.taskDialog.noTagsFound")}</CommandEmpty>
        )}
        <CommandGroup>
          {tags.map((tag) => {
            const selected = selectedIds.includes(tag.id);
            return (
              <CommandItem
                key={tag.id}
                value={tag.name}
                onSelect={() => onToggle(tag.id)}
                className="group gap-2"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: tagDotColor(tag.color) }}
                />
                <span className="flex-1 truncate">{tag.name}</span>
                <button
                  type="button"
                  aria-label={t("taskBoard.taskDialog.deleteTagAriaLabel", {
                    name: tag.name,
                  })}
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-background hover:text-destructive group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(tag.id);
                  }}
                >
                  <Trash03 size={13} />
                </button>
                {selected && (
                  <Check size={14} className="shrink-0 text-foreground" />
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

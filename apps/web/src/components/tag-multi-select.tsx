/**
 * Tag Multi-Select Component
 *
 * Notion-style multi-select for managing member tags.
 * - Shows existing organization tags
 * - Allows creating new tags inline
 * - Supports search/filter
 * - Shows selected tags as badges
 */

import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@deco/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { ChevronDown, Plus, XClose, Loading01 } from "@untitledui/icons";
import {
  useTags,
  useCreateTag,
  useMemberTags,
  useSetMemberTags,
  type Tag,
} from "@/hooks/use-tags";
import { useT } from "@/i18n/use-t";

interface TagMultiSelectProps {
  memberId: string;
  className?: string;
  disabled?: boolean;
  maxDisplay?: number;
}

export function TagMultiSelect({
  memberId,
  className,
  disabled = false,
  maxDisplay = 2,
}: TagMultiSelectProps) {
  const t = useT();
  const [isOpen, setIsOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");

  // Fetch all organization tags
  const { data: orgTags = [], isLoading: isLoadingTags } = useTags();

  // Fetch member's current tags
  const { data: memberTags = [], isLoading: isLoadingMemberTags } =
    useMemberTags(memberId);

  // Mutations
  const createTagMutation = useCreateTag();
  const setMemberTagsMutation = useSetMemberTags();

  const isLoading = isLoadingTags || isLoadingMemberTags;
  const selectedTagIds = memberTags.map((t) => t.id);

  // Filter tags based on search
  const filteredTags = orgTags.filter((tag) =>
    tag.name.toLowerCase().includes(searchValue.toLowerCase()),
  );

  // Check if search matches an existing tag exactly
  const exactMatch = orgTags.find(
    (tag) => tag.name.toLowerCase() === searchValue.toLowerCase(),
  );

  // Should show create option?
  const showCreateOption = searchValue.trim() && !exactMatch;

  const handleToggleTag = async (tag: Tag) => {
    const isSelected = selectedTagIds.includes(tag.id);
    const newTagIds = isSelected
      ? selectedTagIds.filter((id) => id !== tag.id)
      : [...selectedTagIds, tag.id];

    await setMemberTagsMutation.mutateAsync({
      memberId,
      tagIds: newTagIds,
    });
  };

  const handleCreateAndAssign = async () => {
    if (!searchValue.trim()) return;

    // Create the new tag
    const newTag = await createTagMutation.mutateAsync(searchValue.trim());

    // Assign it to the member
    await setMemberTagsMutation.mutateAsync({
      memberId,
      tagIds: [...selectedTagIds, newTag.id],
    });

    setSearchValue("");
  };

  const handleRemoveTag = async (tagId: string) => {
    const newTagIds = selectedTagIds.filter((id) => id !== tagId);
    await setMemberTagsMutation.mutateAsync({
      memberId,
      tagIds: newTagIds,
    });
  };

  const isPending =
    createTagMutation.isPending || setMemberTagsMutation.isPending;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            "h-auto min-h-8 px-2 py-1 justify-start font-normal",
            "hover:bg-accent/50",
            className,
          )}
          disabled={disabled || isLoading}
        >
          {isLoading ? (
            <Loading01
              size={14}
              className="animate-spin text-muted-foreground"
            />
          ) : memberTags.length > 0 ? (
            <div className="flex items-center gap-1 flex-wrap">
              {memberTags.slice(0, maxDisplay).map((tag) => (
                <Badge
                  key={tag.id}
                  variant="secondary"
                  className="text-xs px-1.5 py-0 h-5"
                >
                  {tag.name}
                </Badge>
              ))}
              {memberTags.length > maxDisplay && (
                <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5">
                  +{memberTags.length - maxDisplay}
                </Badge>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("common.tagMultiSelect.addTags")}
            </span>
          )}
          <ChevronDown size={14} className="ml-1 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-0"
        align="start"
        onEscapeKeyDown={() => setIsOpen(false)}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("common.tagMultiSelect.searchOrCreate")}
            value={searchValue}
            onValueChange={setSearchValue}
            className="h-9"
          />
          <CommandList>
            {/* Selected tags with remove option */}
            {memberTags.length > 0 && (
              <>
                <CommandGroup heading={t("common.tagMultiSelect.selected")}>
                  {memberTags.map((tag) => (
                    <CommandItem
                      key={tag.id}
                      onSelect={() => handleToggleTag(tag)}
                      className="cursor-pointer"
                    >
                      <div className="flex items-center justify-between w-full">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={true}
                            className="[&_svg]:!text-primary-foreground"
                          />
                          <span>{tag.name}</span>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveTag(tag.id);
                          }}
                          className="opacity-50 hover:opacity-100"
                          disabled={isPending}
                        >
                          <XClose size={14} />
                        </button>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {/* Available tags */}
            <CommandGroup heading={t("common.tagMultiSelect.available")}>
              {filteredTags.length === 0 && !showCreateOption && (
                <CommandEmpty>
                  {t("common.tagMultiSelect.noTagsFound")}
                </CommandEmpty>
              )}
              {filteredTags
                .filter((tag) => !selectedTagIds.includes(tag.id))
                .map((tag) => (
                  <CommandItem
                    key={tag.id}
                    onSelect={() => handleToggleTag(tag)}
                    className="cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={false}
                        className="[&_svg]:!text-primary-foreground"
                      />
                      <span>{tag.name}</span>
                    </div>
                  </CommandItem>
                ))}
            </CommandGroup>

            {/* Create new tag option */}
            {showCreateOption && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={handleCreateAndAssign}
                    className="cursor-pointer"
                    disabled={isPending}
                  >
                    <div className="flex items-center gap-2 text-primary">
                      {isPending ? (
                        <Loading01 size={14} className="animate-spin" />
                      ) : (
                        <Plus size={14} />
                      )}
                      <span>
                        {t("common.tagMultiSelect.createTag", {
                          tagName: searchValue.trim(),
                        })}
                      </span>
                    </div>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

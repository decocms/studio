/**
 * The one way people attach skills: packages first, then single skills by
 * category. Stores references — catalog ids or `bundle:<id>` — so a package
 * picked once keeps up with the skills its repos add to it.
 */

import { useState } from "react";
import { Package, Plus, XClose } from "@untitledui/icons";
import { bundleRef } from "@decocms/shared/skills";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useOrgFsSkillCatalog } from "@/hooks/use-org-fs";
import { useT } from "@/i18n/use-t.ts";
import {
  bundleSummaries,
  categoryLabel,
  groupByCategory,
  resolveRef,
  skillDisplayName,
  skillSourceLabel,
  type ResolvedRef,
} from "./skill-catalog";
import { useSkillCount } from "./skills-catalog-view";

const NONE: string[] = [];

export function SkillPicker({
  value,
  onChange,
  inherited = NONE,
  inheritedFrom,
  disabled = false,
}: {
  value: string[];
  onChange: (refs: string[]) => void;
  /** References a wider scope already applies; shown, not editable. */
  inherited?: string[];
  /** Where `inherited` comes from, e.g. "Settings → Tasks". */
  inheritedFrom?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const catalog = useOrgFsSkillCatalog().data ?? [];
  const bundles = bundleSummaries(t, catalog);
  const own = value.filter((ref) => !inherited.includes(ref));
  const resolve = (ref: string) => resolveRef(ref, catalog, bundles);

  return (
    <div className="flex flex-col gap-2">
      {(own.length > 0 || inherited.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {own.map((ref) => (
            <RefChip
              key={ref}
              resolved={resolve(ref)}
              onRemove={
                disabled
                  ? undefined
                  : () => onChange(value.filter((r) => r !== ref))
              }
            />
          ))}
          {inherited.map((ref) => (
            <RefChip
              key={ref}
              resolved={resolve(ref)}
              inheritedFrom={inheritedFrom}
            />
          ))}
        </div>
      )}
      {!disabled && (
        <AddSkills
          taken={[...value, ...inherited]}
          onAdd={(ref) => onChange([...value, ref])}
        />
      )}
    </div>
  );
}

function RefChip({
  resolved,
  onRemove,
  inheritedFrom,
}: {
  resolved: ResolvedRef;
  onRemove?: () => void;
  inheritedFrom?: string;
}) {
  const t = useT();
  const memberNames = resolved.bundle?.members.map(skillDisplayName) ?? [];
  const hint = resolved.missing
    ? t("skills.picker.unknown")
    : resolved.bundle
      ? memberNames.length > 0
        ? t("skills.picker.bundleMembers", { names: memberNames.join(", ") })
        : t("skills.picker.bundleEmpty")
      : inheritedFrom
        ? t("skills.picker.inherited", { scope: inheritedFrom })
        : null;

  const chip = (
    <Badge
      variant={inheritedFrom ? "muted" : "outline"}
      className={cn(
        "gap-1 py-0",
        onRemove ? "pr-0 pl-2" : "px-2",
        resolved.missing && "text-muted-foreground line-through",
      )}
    >
      {resolved.bundle && (
        <Package size={12} className="shrink-0 text-muted-foreground" />
      )}
      {resolved.name}
      {resolved.bundle && (
        <span className="text-muted-foreground tnum">
          {resolved.bundle.members.length}
        </span>
      )}
      {onRemove && (
        <IconButton
          label={t("skills.picker.remove", { skill: resolved.name })}
          onClick={onRemove}
          className="size-5 text-muted-foreground"
        >
          <XClose size={12} />
        </IconButton>
      )}
    </Badge>
  );

  if (!hint) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{hint}</TooltipContent>
    </Tooltip>
  );
}

function AddSkills({
  taken,
  onAdd,
}: {
  taken: string[];
  onAdd: (ref: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const skillCount = useSkillCount();
  const catalog = useOrgFsSkillCatalog().data ?? [];
  const bundles = bundleSummaries(t, catalog).filter(
    (b) => b.members.length > 0 && !taken.includes(bundleRef(b.id)),
  );
  // A run can't load a manual-only skill, so a rule can't ask for one.
  const groups = groupByCategory(
    catalog.filter((s) => !s.disableModelInvocation && !taken.includes(s.id)),
  );
  const add = (ref: string) => {
    onAdd(ref);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-fit gap-1.5">
          <Plus size={14} />
          {t("skills.picker.add")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] p-0">
        <Command>
          <CommandInput
            placeholder={t("skills.picker.search")}
            className="h-9"
          />
          <CommandList className="max-h-96">
            <CommandEmpty>{t("skills.picker.empty")}</CommandEmpty>
            {bundles.length > 0 && (
              <CommandGroup heading={t("skills.picker.bundles")}>
                {bundles.map((b) => (
                  <CommandItem
                    key={b.id}
                    value={`bundle ${b.title} ${b.description} ${b.members.map((m) => m.name).join(" ")}`}
                    onSelect={() => add(bundleRef(b.id))}
                    className="items-start"
                  >
                    <Package
                      size={14}
                      className="mt-0.5 shrink-0 text-muted-foreground"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm">{b.title}</span>
                      <span className="text-meta line-clamp-1">
                        {b.description}
                      </span>
                    </span>
                    <span className="text-meta shrink-0">
                      {skillCount(b.members.length)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {groups.map((group) => (
              <CommandGroup
                key={group.key}
                heading={categoryLabel(t, group.key)}
              >
                {group.skills.map((s) => {
                  const source = skillSourceLabel(s.source);
                  return (
                    <CommandItem
                      key={s.id}
                      value={`${skillDisplayName(s)} ${s.name} ${s.id} ${s.description ?? ""}`}
                      onSelect={() => add(s.id)}
                      className="items-start"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">
                          {skillDisplayName(s)}
                        </span>
                        {s.description && (
                          <span className="text-meta line-clamp-1">
                            {s.description}
                          </span>
                        )}
                      </span>
                      {source && (
                        <span className="text-meta shrink-0">{source}</span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

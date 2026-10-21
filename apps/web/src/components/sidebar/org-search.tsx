/**
 * Find an organization the rail is not showing.
 *
 * The rail is bounded (see `lib/recent-orgs.ts`), so for anyone in more than a
 * handful of orgs this is the way to the rest. It lists ALL of them, not just
 * the hidden ones: a person looking for an org should not have to know whether
 * it happens to be on the rail today. Typing searches the server.
 */

import { useState } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SearchLg } from "@untitledui/icons";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { OrgIcon } from "@/components/header/org-switcher";
import { RailItem } from "./rail-item";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useOrganizationSearch } from "@/hooks/use-organization-search";
import { useT } from "@/i18n/use-t.ts";

export interface SearchableOrg {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

export function OrgSearch({
  orgs,
  currentSlug,
  hiddenCount,
  onSelect,
}: {
  orgs: readonly SearchableOrg[];
  currentSlug: string;
  /** Drawn on the trigger so the rail admits what it is not showing. */
  hiddenCount: number;
  onSelect: (slug: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const typed = search.trim();
  const term = useDebouncedValue(typed, 150);
  const searching = typed.length > 0;
  /** The debounce has caught up, so an empty answer is the answer. */
  const settled = term === typed;
  const { hits, isSearching, isStale, isError } = useOrganizationSearch(
    searching ? term : "",
  );
  const rows = searching ? hits : orgs;
  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  return (
    <>
      <RailItem active={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("sidebar.rail.searchOrganizations")}
              onClick={() => openChange(true)}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <SearchLg size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {hiddenCount > 0
              ? t("sidebar.rail.searchMoreOrganizations", {
                  count: hiddenCount,
                })
              : t("sidebar.rail.searchOrganizations")}
          </TooltipContent>
        </Tooltip>
      </RailItem>

      <CommandDialog
        open={open}
        onOpenChange={openChange}
        title={t("sidebar.rail.searchOrganizations")}
        description={t("sidebar.rail.searchPlaceholder")}
        shouldFilter={false}
      >
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={t("sidebar.rail.searchPlaceholder")}
        />
        <CommandList
          className={cn(searching && (isStale || !settled) && "opacity-50")}
        >
          {searching && isError && (
            <CommandEmpty>{t("sidebar.rail.searchFailed")}</CommandEmpty>
          )}
          {!isError && settled && !isSearching && rows.length === 0 && (
            <CommandEmpty>{t("sidebar.rail.searchEmpty")}</CommandEmpty>
          )}
          {rows.map((org) => (
            <CommandItem
              key={org.id}
              value={org.slug}
              onSelect={() => {
                openChange(false);
                if (org.slug !== currentSlug) onSelect(org.slug);
              }}
              className="gap-2.5"
            >
              <OrgIcon org={org} size="sm" />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {org.slug === currentSlug && (
                <span className="text-meta shrink-0">
                  {t("sidebar.rail.currentOrganization")}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
}

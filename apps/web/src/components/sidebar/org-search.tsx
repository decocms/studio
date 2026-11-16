/** Org search for `/site-editor`, where the ⌘K palette is not mounted. Lists every org; typing searches the server. */

import { useState } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { OrgIcon } from "@/components/header/org-switcher";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useOrganizationSearch } from "@/hooks/use-organization-search";
import { useT } from "@/i18n/use-t.ts";

export interface SearchableOrg {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

export function OrgSearchDialog({
  open,
  onOpenChange,
  orgs,
  currentSlug,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgs: readonly SearchableOrg[];
  currentSlug: string;
  onSelect: (slug: string) => void;
}) {
  const t = useT();
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
    onOpenChange(next);
    if (!next) setSearch("");
  };

  return (
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
  );
}

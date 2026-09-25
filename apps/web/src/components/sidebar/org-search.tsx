/**
 * Find an organization the rail is not showing.
 *
 * The rail is bounded (see `lib/recent-orgs.ts`), so for anyone in more than a
 * handful of orgs this is the way to the rest. It lists ALL of them, not just
 * the hidden ones: a person looking for an org should not have to know whether
 * it happens to be on the rail today, and cmdk scores the whole list anyway.
 */

import { useState } from "react";
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

  return (
    <>
      {/* One word under the glyph; the tooltip is where the count and the full
          sentence go. */}
      <RailItem active={false} label={t("sidebar.rail.searchShort")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("sidebar.rail.searchOrganizations")}
              onClick={() => setOpen(true)}
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
        onOpenChange={setOpen}
        title={t("sidebar.rail.searchOrganizations")}
        description={t("sidebar.rail.searchPlaceholder")}
      >
        <CommandInput placeholder={t("sidebar.rail.searchPlaceholder")} />
        <CommandList>
          <CommandEmpty>{t("sidebar.rail.searchEmpty")}</CommandEmpty>
          {orgs.map((org) => (
            <CommandItem
              key={org.id}
              /* The slug is searchable too — it is what appears in the URL,
                 so it is often what someone half-remembers. */
              value={`${org.name} ${org.slug}`}
              onSelect={() => {
                setOpen(false);
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

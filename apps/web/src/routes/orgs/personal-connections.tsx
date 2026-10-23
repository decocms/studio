/**
 * Connections → Just you: accounts a person connects for themselves, usable
 * in any chat or project of the org and invisible to teammates. The third
 * level after the org's and a project's connections.
 *
 * Screen only: the API has no user-owned connections yet, so the list is
 * empty and Connect waits behind "Coming soon".
 */

import { Suspense, useDeferredValue, useState } from "react";
import { Building02, Container, Lock01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { SearchToggle } from "@decocms/ui/components/search-toggle.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { getStudioMcpMetadata } from "@decocms/shared/registry/metadata";
import { ConnectionCard } from "@/components/connections/connection-card.tsx";
import { Page } from "@/components/page";
import type { RegistryItem } from "@/components/store/types";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { useRegistryCatalog } from "@/hooks/use-registry-catalog";
import { useT } from "@/i18n/use-t.ts";
import { useConnections, useProjectContext } from "@/sdk";
import { getRegistryItemAppName } from "@/utils/extract-connection-data";
import { getGitHubAvatarUrl } from "@/utils/github.ts";

function Yours() {
  const t = useT();
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">
        {t("orgs.personalConnections.yours")}
      </h2>
      <div className="surface-inset flex flex-col items-center gap-1 rounded-xl px-6 py-10 text-center">
        <Lock01 size={20} className="mb-2 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t("orgs.personalConnections.emptyTitle")}
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("orgs.personalConnections.emptyDescription")}
        </p>
      </div>
    </section>
  );
}

function itemCard(item: RegistryItem) {
  const meta = getStudioMcpMetadata(item._meta);
  return {
    title:
      meta?.friendlyName ||
      meta?.friendly_name ||
      item.server?.title ||
      item.title ||
      item.server?.name ||
      item.name ||
      item.id ||
      "",
    description: item.server?.description || item.description || null,
    icon:
      item.server?.icons?.[0]?.src ||
      getGitHubAvatarUrl(item.server?.repository) ||
      null,
  };
}

function CatalogGrid({ search }: { search: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const catalog = useRegistryCatalog(search);
  const sentinelRef = useInfiniteScroll(
    catalog.loadMore,
    catalog.hasMore,
    catalog.isLoadingMore,
  );
  // An app the org already shares is one this person may not need for themselves.
  const orgApps = new Set(
    useConnections()
      .map((c) => c.app_name)
      .filter((name): name is string => Boolean(name)),
  );

  if (catalog.isInitialLoading) return <CatalogSkeleton />;

  if (catalog.items.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {t("orgs.personalConnections.noResults", { query: search })}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
      {catalog.items.map((item) => {
        const appName = getRegistryItemAppName(item);
        return (
          <ConnectionCard
            key={item.id}
            connection={itemCard(item)}
            fallbackIcon={<Container />}
            headerActionsAlwaysVisible
            headerActions={
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A disabled button swallows hover, so the span carries the tooltip. */}
                  <span tabIndex={0} className="focus-ring rounded-lg">
                    <Button variant="outline" size="sm" disabled>
                      {t("orgs.personalConnections.connect")}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t("orgs.personalConnections.comingSoon")}
                </TooltipContent>
              </Tooltip>
            }
            footer={
              appName && orgApps.has(appName) ? (
                <span className="flex items-center gap-1.5 text-meta">
                  <Building02 size={12} />
                  {t("orgs.personalConnections.sharedByOrg", { org: org.name })}
                </span>
              ) : undefined
            }
          />
        );
      })}
      <div ref={sentinelRef} className="col-span-full h-4" />
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-[132px] rounded-xl" />
      ))}
    </div>
  );
}

export default function PersonalConnections() {
  const t = useT();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <Page.Actions
            secondary={
              <SearchToggle
                value={search}
                onChange={setSearch}
                label={t("library.context.search")}
                placeholder={t("orgs.personalConnections.searchPlaceholder")}
                clearLabel={t("library.library.clearSearch")}
              />
            }
          >
            <Badge variant="muted">
              {t("orgs.personalConnections.comingSoon")}
            </Badge>
          </Page.Actions>
          <div className="flex flex-col gap-8">
            <Yours />
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">
                {t("orgs.personalConnections.connectAccount")}
              </h2>
              <Suspense fallback={<CatalogSkeleton />}>
                <CatalogGrid search={deferredSearch} />
              </Suspense>
            </section>
          </div>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

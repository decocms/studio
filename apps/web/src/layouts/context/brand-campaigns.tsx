/**
 * The brand's campaigns: the organization's, kept beside its brand guide and
 * read from its VTEX connection. Reached from the brand page's Content group.
 */

import { EmptyState } from "@/components/empty-state";
import { BlogConnectionsGate } from "@/components/sandbox/content/blog/blog-connections-gate";
import { BlogStateConflict } from "@/components/sandbox/content/blog/blog-state-conflict";
import { useVtexCatalogSource } from "@/components/sandbox/content/blog/blocks/vtex-mcp-source";
import { CampaignsPanel } from "@/components/sandbox/content/blog/campaigns-panel";
import { useBlogConnections } from "@/components/sandbox/content/blog/use-blog-connections";
import { useBlogState } from "@/components/sandbox/content/blog/use-blog-state";
import { useBlogAi } from "@/hooks/use-blog-ai";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";

export function BrandCampaigns() {
  const t = useT();
  const blogAi = useBlogAi();
  if (!blogAi) {
    return (
      <EmptyState
        image={null}
        title={t("library.context.campaignsOffTitle")}
        description={t("library.context.campaignsOffDescription")}
      />
    );
  }
  return (
    <BlogConnectionsGate>
      <Campaigns />
    </BlogConnectionsGate>
  );
}

export function Campaigns() {
  const { org } = useProjectContext();
  const blog = useBlogState({ orgSlug: org.slug });
  const { vtex } = useBlogConnections();
  const catalog = useVtexCatalogSource(vtex.connectionId);
  return (
    <div className="flex flex-col gap-3">
      <BlogStateConflict blog={blog} />
      <CampaignsPanel blog={blog} catalog={catalog} />
    </div>
  );
}

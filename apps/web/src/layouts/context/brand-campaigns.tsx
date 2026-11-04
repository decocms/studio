/**
 * The brand's campaigns: the organization's, kept beside its brand guide.
 * Reached from the brand page's Content group; a campaign opens on its page in
 * the organization's content track.
 */

import { useNavigate } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import { BlogConnectionsGate } from "@/components/sandbox/content/blog/blog-connections-gate";
import { CampaignsPanel } from "@/components/sandbox/content/blog/campaigns-panel";
import { useBlogState } from "@/components/sandbox/content/blog/use-blog-state";
import { useBlogAi } from "@/hooks/use-blog-ai";
import { useBrandLiveSync } from "@/hooks/use-brand-events";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";

export function BrandCampaigns() {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const blogAi = useBlogAi();
  // Drafts an agent writes into the brand folder land here as they are written.
  useBrandLiveSync();
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
      <Campaigns
        onOpen={(campaign) =>
          void navigate({
            to: "/$org/tasks/{-$taskKey}",
            params: { org: org.slug, taskKey: undefined },
            search: { track: "content", view: "campaigns", campaign },
          })
        }
      />
    </BlogConnectionsGate>
  );
}

export function Campaigns({
  onOpen,
}: {
  /** Open a campaign's page. */
  onOpen: (campaignId: string) => void;
}) {
  const { org } = useProjectContext();
  const blog = useBlogState({ orgSlug: org.slug });
  return <CampaignsPanel blog={blog} onOpen={onOpen} />;
}

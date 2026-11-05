import { ChatLayout } from "@/components/chat-layout";
import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";
import { FeatureGate } from "@/components/paywall/feature-gate";
import { BlogTab } from "@/layouts/main-panel-tabs/blog-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { AgentViewGuard } from "./agent-view-guard";

function AgentBlogContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <AgentViewGuard tabId="blog">
      <FeatureGate feature="cms">
        <BlogTab virtualMcpId={virtualMcpId} />
      </FeatureGate>
    </AgentViewGuard>
  );
}

export default function AgentBlogRoute() {
  return (
    // The site's draft bar: Blog's drafts are sandboxes, so it shows the
    // coding session's Publish (`siteDraftBarParts`).
    <ChatLayout.Content actions={<SiteDraftActions />}>
      <AgentBlogContent />
    </ChatLayout.Content>
  );
}

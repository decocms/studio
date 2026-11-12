import { ChatLayout } from "@/components/chat-layout";
import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";
import { FeatureGate } from "@/components/paywall/feature-gate";
import { BlogPostTab } from "@/layouts/main-panel-tabs/blog-post-tab";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { BlogViewGate } from "./blog-view-gate";

function AgentBlogPostContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  return (
    <BlogViewGate>
      <FeatureGate feature="cms">
        <BlogPostTab virtualMcpId={virtualMcpId} />
      </FeatureGate>
    </BlogViewGate>
  );
}

/** No `AgentViewGuard`: its tab id carries the post, and the guard compares
 *  against the resolved active tab — which is this very route's. The Blog row
 *  the post belongs to is guarded at `/blog`. */
export default function AgentBlogPostRoute() {
  return (
    // The site's draft bar: Blog's drafts are sandboxes, so it shows the
    // coding session's Publish (`siteDraftBarParts`).
    <ChatLayout.Content actions={<SiteDraftActions />}>
      <AgentBlogPostContent />
    </ChatLayout.Content>
  );
}

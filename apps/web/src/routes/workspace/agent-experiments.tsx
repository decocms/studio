import { ChatLayout } from "@/components/chat-layout";
import { SiteDraftActions } from "@/components/site-draft-bar/site-draft-actions";
import { ExperimentsTab } from "@/layouts/main-panel-tabs/experiments-tab";
import { ExperimentsTabSkeleton } from "@/layouts/main-panel-tabs/experiments-tab-v8";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import {
  editsBlocksDraft,
  experimentsTabVisible,
} from "@/layouts/main-panel-tabs/experiments-tab-choice";

function AgentExperimentsContent() {
  const virtualMcpId = useRouteVirtualMcpId();
  const views = useControlPlaneViews();
  const siteMajor = useMainSchemaV8(virtualMcpId);
  if (experimentsTabVisible(views.experiments, siteMajor)) {
    return <ExperimentsTab virtualMcpId={virtualMcpId} />;
  }
  // Whether a site is v8 (and so gets the tab) isn't known yet: wait.
  if (siteMajor === "loading") return <ExperimentsTabSkeleton />;
  return <SettingsTab virtualMcpId={virtualMcpId} />;
}

/** A Blocks (v8) site's tests are edits to its draft: the site editor's
 *  draft bar (environment and Publish) sits on top, as on Calendar. */
function ExperimentsActions() {
  const virtualMcpId = useRouteVirtualMcpId();
  const siteMajor = useMainSchemaV8(virtualMcpId);
  return editsBlocksDraft(siteMajor) ? <SiteDraftActions /> : null;
}

export default function AgentExperimentsRoute() {
  return (
    <ChatLayout.Content actions={<ExperimentsActions />}>
      <AgentExperimentsContent />
    </ChatLayout.Content>
  );
}

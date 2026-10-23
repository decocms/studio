/**
 * The site's draft bar: the content version, the environment (draft) select
 * and Publish. One component for every view that edits the site's draft —
 * the site editor, Experiments and Calendar — so a test or a campaign is
 * changed in the same draft as the pages and published the same way.
 * Mounted as a `ChatLayout.Content` route's `actions`.
 */

import { Separator } from "@decocms/ui/components/separator.tsx";
import { ChatModeRow } from "@/components/chat/pills/chat-mode-row";
import { useOptionalChatTask } from "@/components/chat/context";
import { CmsHeaderActions } from "@/components/thread/repository/cms-header-actions";
import { PublishCodeTab } from "@/components/thread/repository/cms-publish-compare";
import { HeaderActions } from "@/components/thread/repository/header-actions";
import { LocalChangesButton } from "@/components/thread/repository/local-changes-dialog";
import { ContentVersionBadge } from "@/components/sections-editor/content-version-badge";
import { DecoServeReadOnlyBadge } from "@/components/sections-editor/deco-serve-read-only-badge";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { agentShowsRepositoryHeaderActions } from "@/lib/agent-capabilities";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { editsBlocksDraft } from "@/layouts/main-panel-tabs/experiments-tab-choice";
import { useRouteVirtualMcpId } from "@/layouts/thread-route";
import { siteDraftBarParts } from "./site-draft-bar-parts";

/**
 * `blocksOnly`: Experiments and Calendar show the bar only on a Blocks (v8)
 * site, where a test or a campaign is an edit to its draft; a v7 site's
 * Experiments keeps its own page, with no bar. Their publish panel has no
 * Code tab (PO decision); the site editor's keeps it. The bar itself is the
 * same on all three views: a view's own actions sit in the view's header.
 */
export function SiteDraftActions({ blocksOnly }: { blocksOnly?: boolean }) {
  return blocksOnly ? <BlocksSiteDraftActions /> : <SiteDraftBar />;
}

function BlocksSiteDraftActions() {
  const siteMajor = useMainSchemaV8(useRouteVirtualMcpId());
  return editsBlocksDraft(siteMajor) ? (
    <PublishCodeTab value={false}>
      <SiteDraftBar />
    </PublishCodeTab>
  ) : null;
}

function SiteDraftBar() {
  const session = useOptionalChatTask();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(session?.virtualMcpId);
  const currentBranch = session?.currentBranch ?? null;
  const runtime = useSessionRuntime(entity?.id).runtime;
  const { url: localPreviewUrl, undecided: tunnelUndecided } =
    useLocalPreviewUrl(entity?.id);
  // Outside a project (`/site-editor`) a connected `deco serve` is the only
  // thing behind the editor.
  const { connection: serveConnection } = useDecoServeConnection(
    entity?.id ?? session?.virtualMcpId,
  );
  const virtualMcpId = entity?.id ?? session?.virtualMcpId;
  const parts = siteDraftBarParts({
    hasEntity: !!entity,
    servingLocally: !!serveConnection,
    localPreview: !!localPreviewUrl,
    tunnelUndecided: !!tunnelUndecided,
    showsRepositoryActions:
      !!entity && agentShowsRepositoryHeaderActions(entity),
    runtime,
  });
  if (!virtualMcpId || parts.hidden) return null;
  return (
    <>
      <ContentVersionBadge virtualMcpId={virtualMcpId} branch={currentBranch} />
      {parts.localFiles && (
        <DecoServeReadOnlyBadge
          virtualMcpId={virtualMcpId}
          branch={currentBranch}
        />
      )}
      {parts.localFiles && (
        // What the editor saved since the last commit; no Publish here.
        <LocalChangesButton
          orgSlug={org.slug}
          virtualMcpId={virtualMcpId}
          branch={currentBranch}
        />
      )}
      {entity && parts.draftSelect && (
        <div className="flex min-w-0 shrink items-center justify-end">
          <ChatModeRow virtualMcp={entity} currentBranch={currentBranch} />
        </div>
      )}
      {entity && parts.publish && (
        <>
          <Separator
            orientation="vertical"
            className="mx-1 data-[orientation=vertical]:h-4"
          />
          <div className="flex shrink-0 items-center justify-end gap-1">
            {parts.publish === "cms" ? (
              <CmsHeaderActions virtualMcpId={entity.id} />
            ) : (
              <HeaderActions virtualMcpId={entity.id} />
            )}
          </div>
        </>
      )}
    </>
  );
}

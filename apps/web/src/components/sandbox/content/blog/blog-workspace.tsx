import type { ReactNode } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { BookOpen01 } from "@untitledui/icons";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { useChatTask } from "@/components/chat/context";
import { useProjectContext } from "@/sdk";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import {
  isProtocolProject,
  servePreviewUrl,
} from "@/components/sections-editor/content-backend";
import { BlocksSiteEditorProvider } from "@/components/sections-editor/blocks-site-editor";
import {
  ContentBackendWaiting,
  isSiteNotOwned,
  SiteNotOwnedState,
} from "@/layouts/main-panel-tabs/blocks-tab-states";
import { useConflictMembers } from "@/components/sections-editor/conflict-author";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useT } from "@/i18n/use-t.ts";
import { SandboxStateRenderer } from "../sandbox-state-renderer";
import { resolveContentSandboxGate } from "../content-sandbox-gate";
import { EmptyMessage } from "../empty-message";
import { BLOG_KINDS, scanBlogEntries } from "./blog-data";
import { findBlogPageSlug } from "./blog-preview-url";

export interface BlogWorkspaceContext {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  /**
   * Sandbox dev-server origin, for anything that EXECUTES against the site
   * (`@options` fields, loaders). Null without a pod.
   */
  previewUrl: string | null;
  /** Origin for LINKS to the site's own pages and for the post preview: a
   *  connected `deco serve` or a Local tunnel when one is on, else Fast
   *  Preview's preview server, else the sandbox's dev server. */
  sitePreviewUrl: string | null;
  /** The post preview renders this session's Fast Preview draft
   *  (`?__draft=`): Fast Preview with no Localhost or Local tunnel in front. */
  fastPreviewActive: boolean;
  /** A hosted v8 draft: a delete is a draft change, undone by discarding it. */
  hostedDraft: boolean;
}

/**
 * Everything both Blog routes need before they can show anything: the session
 * is ready (a sandbox is up; Fast Preview has none to wait for), the decofile
 * and schema have landed, and this site actually has a blog.
 *
 * A render prop rather than a hook because the sandbox card has to replace the
 * whole body, and the data reads below it must not run until the gate opens —
 * which a hook could only express by returning a union every caller then has
 * to switch on anyway.
 */
export function BlogWorkspace({
  children,
}: {
  children: (context: BlogWorkspaceContext) => ReactNode;
}) {
  const { currentBranch: branch, virtualMcpId } = useChatTask();
  const { org } = useProjectContext();
  const vmEvents = useSandboxEvents();
  const lifecycle = useSandboxLifecycle();
  const { runtime, previewServerUrl } = useSessionRuntime(virtualMcpId);
  const { url: tunnelUrl } = useLocalPreviewUrl(virtualMcpId);
  const contentBackend = useContentBackend(virtualMcpId, branch);
  const protocolActive = isProtocolProject(contentBackend);
  const hostedDraft =
    contentBackend.kind === "protocol" && contentBackend.source === "github";
  // The reconcile window names who made the other change (hosted v8).
  useConflictMembers(hostedDraft);
  const gate = resolveContentSandboxGate({
    // Neither a content-protocol backend nor Fast Preview has a pod to boot.
    fastPreviewActive: protocolActive || runtime === "cms",
    previewState: lifecycle.previewState,
    lifecyclePhase: vmEvents.lifecycle.phase,
  });
  // As the Site Editor's preview: Localhost, else the Local tunnel, else Fast
  // Preview's draft on the preview server, else the sandbox.
  const localPreviewUrl = servePreviewUrl(contentBackend) ?? tunnelUrl;
  const fastPreviewActive = runtime === "cms" && !localPreviewUrl;

  if (gate.kind === "sandbox-card") {
    return (
      <SandboxStateRenderer
        state={gate.state}
        claimPhase={vmEvents.phase}
        lifecycle={vmEvents.lifecycle}
        onStart={lifecycle.start}
        connectionsHref={`/${org.slug}/settings/connections`}
      />
    );
  }

  if (!virtualMcpId || !branch) {
    return <EmptyMessage title="Waiting for sandbox context…" />;
  }

  // A v8 site another project owns: say where it's edited, never an error.
  if (isSiteNotOwned(contentBackend)) return <SiteNotOwnedState />;
  // v7 or v8 isn't decided yet: wait (and say so when its read is retried).
  if (contentBackend.kind === "pending") {
    return <ContentBackendWaiting backend={contentBackend} />;
  }

  return (
    <BlocksSiteEditorProvider value={protocolActive}>
      <BlogWorkspaceData
        orgSlug={org.slug}
        virtualMcpId={virtualMcpId}
        branch={branch}
        // The protocol never runs site code: nothing executes against a pod.
        previewUrl={protocolActive ? null : lifecycle.previewUrl}
        sitePreviewUrl={
          localPreviewUrl ??
          (fastPreviewActive ? previewServerUrl : lifecycle.previewUrl)
        }
        fastPreviewActive={fastPreviewActive}
        hostedDraft={hostedDraft}
        devServerReady={gate.devServerReady}
        sandboxWarming={gate.sandboxWarming}
      >
        {children}
      </BlogWorkspaceData>
    </BlocksSiteEditorProvider>
  );
}

function BlogWorkspaceData({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  sitePreviewUrl,
  fastPreviewActive,
  hostedDraft,
  devServerReady,
  sandboxWarming,
  children,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  sitePreviewUrl: string | null;
  fastPreviewActive: boolean;
  hostedDraft: boolean;
  devServerReady: boolean;
  sandboxWarming: boolean;
  children: (context: BlogWorkspaceContext) => ReactNode;
}) {
  const t = useT();
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const fetchParams = { orgSlug, virtualMcpId, branch, threadId, previewUrl };
  const { data: decofile, isLoading: decofileLoading } = useDecofile(
    fetchParams,
    { fetchEnabled: devServerReady },
  );
  const { data: meta, isLoading: metaLoading } = useLiveMeta(fetchParams, {
    fetchEnabled: devServerReady,
  });

  // The committed snapshot outlives the dev server, so only spin while warming.
  const dataMissing = !decofile || !meta;
  if (decofileLoading || metaLoading || (dataMissing && sandboxWarming)) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (dataMissing) {
    return <EmptyMessage title="Could not load site data." />;
  }

  /**
   * Resolved, and this site has no blog: no post route to render one, and no
   * records to list either. Checked here and not in the sidebar, where it
   * would have to wait on this same read — a row that blinks in is worse than
   * a row that explains itself.
   */
  const entries = scanBlogEntries(decofile);
  const hasRecords = BLOG_KINDS.some((kind) => entries[kind].length > 0);
  if (!hasRecords && !findBlogPageSlug(decofile, meta)) {
    return (
      <EmptyState
        className="h-full"
        icon={<BookOpen01 size={22} />}
        title={t("sandbox.blogWorkspace.noBlogApp")}
        description={t("sandbox.blogWorkspace.noBlogAppHint")}
      />
    );
  }

  return children({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
    previewUrl,
    sitePreviewUrl,
    fastPreviewActive,
    hostedDraft,
  });
}

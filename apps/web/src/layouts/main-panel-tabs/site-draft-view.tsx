/**
 * The body of a view that edits a Blocks (v8) site's draft outside the site
 * editor — Experiments and Calendar. Both wait for the same things in the
 * same order (a draft picked in the bar above, the site's content source,
 * the draft's blocks and the site's schema) and guide the same way while
 * they can't show yet, so the steps live here once.
 */

import type { ReactNode } from "react";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Page } from "@/components/page";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { useConflictMembers } from "@/components/sections-editor/conflict-author";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import {
  useDecofile,
  useEnsureDecofileBlocks,
  useIndexNamesOfType,
} from "@/components/sections-editor/use-decofile";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { isSiteNotOwned, SiteNotOwnedState } from "./blocks-tab-states";
import { usePanelNavigate } from "./use-panel-navigate";
import { preloadSiteEditorContentOnShow } from "./preload-site-editor-content";

export interface SiteDraftGuideAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/** One calm step: what's missing and the one thing to do about it. */
export function SiteDraftGuide({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: SiteDraftGuideAction;
}) {
  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <EmptyState
            icon={icon}
            title={title}
            description={description}
            buttonProps={
              action
                ? {
                    children: action.label,
                    onClick: action.onClick,
                    disabled: action.disabled,
                  }
                : undefined
            }
          />
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

export interface SiteDraftViewReady {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
}

export interface SiteDraftViewCopy {
  noDraftTitle: string;
  noDraftDesc: string;
  loadFailed: string;
  loadFailedHint: string;
}

export function SiteDraftView({
  virtualMcpId,
  icon,
  copy,
  skeleton,
  children,
}: {
  virtualMcpId: string;
  icon: ReactNode;
  copy: SiteDraftViewCopy;
  skeleton: ReactNode;
  children: (ready: SiteDraftViewReady) => ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const task = useOptionalChatTask();
  const branch = task?.currentBranch ?? null;
  const backend = useContentBackend(virtualMcpId, branch);
  // An A/B test or campaign save's reconcile window names who made the
  // other change from the members read here (hosted v8 only).
  useConflictMembers(
    backend.kind === "protocol" && backend.source === "github",
  );
  const { openPanel } = usePanelNavigate();

  if (!branch) {
    return (
      <SiteDraftGuide
        icon={icon}
        title={copy.noDraftTitle}
        description={copy.noDraftDesc}
        action={{
          label: t("sectionsEditor.namedRules.openEditor"),
          onClick: () => openPanel("content"),
        }}
      />
    );
  }
  if (isSiteNotOwned(backend)) return <SiteNotOwnedState />;
  if (backend.kind === "pending") return <>{skeleton}</>;
  if (backend.kind !== "protocol") {
    return (
      <SiteDraftGuide
        icon={icon}
        title={copy.loadFailed}
        description={copy.loadFailedHint}
      />
    );
  }
  return (
    <SiteDraftLoaded
      key={branch}
      orgSlug={org.slug}
      virtualMcpId={virtualMcpId}
      branch={branch}
      threadId={task?.taskId ?? null}
      icon={icon}
      copy={copy}
      skeleton={skeleton}
    >
      {children}
    </SiteDraftLoaded>
  );
}

function SiteDraftLoaded({
  orgSlug,
  virtualMcpId,
  branch,
  threadId,
  icon,
  copy,
  skeleton,
  children,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
  icon: ReactNode;
  copy: SiteDraftViewCopy;
  skeleton: ReactNode;
  children: (ready: SiteDraftViewReady) => ReactNode;
}) {
  const t = useT();
  const params = { orgSlug, virtualMcpId, branch, threadId, previewUrl: null };
  const decofileQuery = useDecofile(params);
  const metaQuery = useLiveMeta(params);
  // Hosted v8: these views read the rules and every block that uses them
  // ("Used by", and the uses a rename or delete rewrites). A use names a test
  // or campaign inside a body (`experiment { name }`), which the index's
  // `refs` don't carry (they name saved blocks), so they load every body the
  // index names: once, then only the names a poll shows new or moved.
  const scope = { orgSlug, virtualMcpId, branch };
  const load = useEnsureDecofileBlocks(
    scope,
    useIndexNamesOfType(scope, () => true),
  );
  const decofile = decofileQuery.data as Record<string, unknown> | undefined;
  const meta = metaQuery.data;

  if (!decofile || !meta || !load.ready) {
    if (decofileQuery.isError || metaQuery.isError || load.failed) {
      return (
        <SiteDraftGuide
          icon={icon}
          title={copy.loadFailed}
          description={copy.loadFailedHint}
          action={{
            label: t("sectionsEditor.namedRules.tryAgain"),
            onClick: () => {
              if (decofileQuery.isError) void decofileQuery.refetch();
              if (metaQuery.isError) void metaQuery.refetch();
              if (load.failed) load.retry();
            },
          }}
        />
      );
    }
    return <>{skeleton}</>;
  }
  return (
    // Their "Used by" opens the site editor: its code is ready by the click.
    <div className="contents" ref={preloadSiteEditorContentOnShow}>
      {children({ orgSlug, virtualMcpId, branch, threadId, decofile, meta })}
    </div>
  );
}

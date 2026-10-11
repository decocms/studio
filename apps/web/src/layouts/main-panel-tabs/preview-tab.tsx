import { useState } from "react";
import { NewBlocksEditorProvider } from "@/hooks/use-new-blocks-editor";
import { useChatTask } from "@/components/chat/chat-context";
import { PreviewContent } from "@/components/sandbox/preview/preview";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useVirtualMCP } from "@/sdk";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@/components/empty-state";
import { GitHubIcon } from "@/components/icons/github-icon";
import { RepositoryImportPicker } from "@/components/repository-import-picker";
import { useT } from "@/i18n/use-t.ts";
import { resolvePreviewSource } from "./preview-source";
import { useLocalAppReachable } from "@/hooks/use-local-app-reachable";
import { servePreviewUrl } from "@/components/sections-editor/content-backend";
import {
  endpointHost,
  SERVE_COMMAND,
} from "@/components/sections-editor/deco-serve-connection";
import {
  DocsLinks,
  LocalNetworkDeniedAlert,
  RichCode,
  serveProblemCopy,
} from "@/components/sections-editor/deco-serve-notices";
import {
  type LocalhostStatus,
  localhostStatus,
} from "@/components/sections-editor/localhost-status";
import { ServeConnectState } from "@/components/sections-editor/serve-connect-state";
import { useLocalNetworkAccess } from "@/hooks/use-deco-serve-discovery";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import { useTaskMetadata } from "./use-task-metadata";

export function PreviewTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const { connection: serveConnection } = useDecoServeConnection(virtualMcpId);
  const { activeTask, taskId, currentBranch } = useChatTask();
  const threadMetadata = useTaskMetadata(taskId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const backend = useContentBackend(virtualMcpId, currentBranch);
  // Localhost's app (what `deco serve` reports): the preview waits until it
  // answers, and reloads on its own when it comes back.
  const localAppUrl = serveConnection ? servePreviewUrl(backend) : null;
  const localAppUp = useLocalAppReachable(localAppUrl);
  const access = useLocalNetworkAccess();
  // Resolved exactly like the tab bar (see preview-source) off the same thread
  // metadata, so a visible Preview tab can never render "no source to preview"
  // — and a repo-less sandbox task run, whose tab is hidden, still renders the
  // empty state if it is deep-linked to.
  const previewSource = resolvePreviewSource({
    threadId: taskId,
    sandboxBranch: activeTask?.branch ?? currentBranch,
    agentHasRepo: agentHasClonableSource(entity?.metadata),
    threadHasRepo:
      agentHasClonableSource(threadMetadata) ||
      agentHasClonableSource(activeTask?.metadata),
  });

  // A connected `deco serve` is a source of its own (`/site-editor` has no repo).
  if (previewSource === "none" && !serveConnection) {
    return (
      <>
        <EmptyState
          className="h-full"
          image={
            <div className="flex size-14 items-center justify-center rounded-full bg-muted">
              <GitHubIcon className="size-7 text-foreground" />
            </div>
          }
          title={t("mainPanelTabs.previewTab.noSourceToPreview")}
          description={t("mainPanelTabs.previewTab.connectGithubDescription")}
          actions={
            <Button onClick={() => setPickerOpen(true)}>
              <GitHubIcon className="size-4" />
              {t("mainPanelTabs.previewTab.connectGithub")}
            </Button>
          }
        />
        <RepositoryImportPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          mode="agent"
        />
      </>
    );
  }

  // Localhost (a project's `deco serve`): the preview is the app it reports.
  // Until there is one, guide instead of booting a sandbox or showing the
  // hosted draft. `/site-editor` has its own gate.
  if (serveConnection && entity && !servePreviewUrl(backend)) {
    return (
      <LocalhostEmptyState
        status={localhostStatus({ backend, access })}
        host={endpointHost(serveConnection.endpoint)}
      />
    );
  }

  // `deco serve` names the app, but it isn't answering (still starting, or
  // restarting): guide until it does, then load it fresh. Showing the frame
  // now would leave Chrome's error page until a save or a reload.
  if (localAppUrl && localAppUp !== true) {
    return (
      <ServeConnectState
        headingLevel={2}
        waiting
        title={t("mainPanelTabs.previewTab.localAppWaiting.title")}
        lead={
          <RichCode
            text={t("mainPanelTabs.previewTab.localAppWaiting.body", {
              host: hostOf(localAppUrl),
            })}
          />
        }
        footer={
          <p
            role="status"
            className="text-center text-sm text-muted-foreground"
          >
            {t("mainPanelTabs.previewTab.localAppWaiting.hint")}
          </p>
        }
      />
    );
  }

  return (
    <NewBlocksEditorProvider>
      <PreviewContent virtualMcpId={virtualMcpId} />
    </NewBlocksEditorProvider>
  );
}

/** `host:port` of the app's URL, for the guide. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A chosen Localhost with no app to show yet: the same empty state as
 * `/site-editor`'s guide, with the one next step for where it stands.
 */
function LocalhostEmptyState({
  status,
  host,
}: {
  status: LocalhostStatus;
  host: string;
}) {
  const t = useT();
  if (status.kind === "connected") {
    // Connected, but `deco serve` reports no app.
    return (
      <ServeConnectState
        headingLevel={2}
        waiting={false}
        title={t("mainPanelTabs.previewTab.localhostNoPreview.title")}
        lead={
          <RichCode
            text={t("mainPanelTabs.previewTab.localhostNoPreview.body")}
          />
        }
        steps={[
          {
            title: t("mainPanelTabs.previewTab.localhostNoPreview.step.title"),
            command: `${SERVE_COMMAND} --preview localhost:3000`,
          },
        ]}
      />
    );
  }
  if (status.kind === "problem") {
    // Something answered but can't be used; it keeps checking on its own.
    const { title, body } = serveProblemCopy(t, status.problem, host);
    return (
      <ServeConnectState
        headingLevel={2}
        waiting={false}
        title={title}
        lead={<RichCode text={body} />}
        footer={
          <DocsLinks
            className="border-t border-border pt-4"
            links={["troubleshooting", "serve"]}
          />
        }
      />
    );
  }
  const blocked = status.kind === "needs-permission";
  return (
    <ServeConnectState
      headingLevel={2}
      waiting={!blocked}
      title={t("mainPanelTabs.previewTab.localhostWaiting.title")}
      lead={t("mainPanelTabs.previewTab.localhostWaiting.body")}
      alerts={blocked && <LocalNetworkDeniedAlert />}
      steps={[
        {
          title: t("decoServe.guide.step1.title"),
          body: <RichCode text={t("decoServe.guide.step1.body")} />,
          command: SERVE_COMMAND,
        },
        {
          title: t("mainPanelTabs.previewTab.localhostWaiting.step2.title"),
          body: t("mainPanelTabs.previewTab.localhostWaiting.step2.body"),
          after: !blocked && (
            <p role="status" className="text-sm text-muted-foreground">
              {status.kind === "connecting"
                ? t("decoServe.connect.reaching", { host })
                : t("decoServe.guide.step2.looking", { hosts: host })}
            </p>
          ),
        },
      ]}
      footer={
        <DocsLinks
          className="border-t border-border pt-4"
          links={["siteEditor", "serve", "troubleshooting"]}
        />
      }
    />
  );
}

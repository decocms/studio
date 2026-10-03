/**
 * `/site-editor#endpoint=…&token=…` — the site editor over the `deco serve`
 * on this machine (the link the Blocks CLI prints), without a project.
 *
 * It exists only with the New Layout preference (`projectFirstNav`) on — the
 * router answers not-found otherwise — and is the Site Editor app as a project
 * launches it in that frame: the org rail (signed in only, as there are no
 * orgs to list otherwise), then the app with its Preview and Content tabs. Preview loads the app `deco serve --preview` names. What needs
 * Studio's hosting is left out: no GitHub backend, drafts, publishing or Code.
 *
 * The connection leaves the fragment at once (so the token never stays in
 * the address bar or history) and is kept for this tab only. Only loopback
 * servers are accepted (`parseConnectFragment`).
 *
 * The editor surfaces expect a project and a chat task: they get a
 * placeholder project, in an org with no id (which makes the Studio-backed
 * reads skip themselves), and a task with no thread. The connection reaches
 * every surface through `TabDecoServeConnectionContext`.
 */

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  ChatTaskValueProvider,
  type ChatTaskContextValue,
} from "@/components/chat/context";
import { Layout } from "@/components/layout";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { BlocksPreviewWorkspaceProvider } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
import { ContentBrowser } from "@/components/sandbox/content/content-browser";
import { PreviewContent } from "@/components/sandbox/preview/preview";
import { ContentVersionBadge } from "@/components/sections-editor/content-version-badge";
import {
  ConnectCentered as Centered,
  DecoServeChip,
} from "@/components/sections-editor/deco-serve-chip";
import {
  type DecoServeConnection,
  clearTabConnection,
  parseConnectFragment,
  readTabConnection,
  saveTabConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import {
  type DecoServeConnectionState,
  TabDecoServeConnectionContext,
} from "@/hooks/use-deco-serve-connection";
import { useT } from "@/i18n/use-t.ts";
import { TabIconGlyph } from "@/layouts/main-panel-tabs/tab-icon-glyph";
import { resolveTabIcon } from "@/layouts/main-panel-tabs/resolve-tab-icon";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import { ProjectContextProvider } from "@/sdk";

/** Stands in for the project id every editor hook is keyed by. */
const LOCAL_PROJECT_ID = "deco-serve";
/** Stands in for the branch: `deco serve` edits the working tree. */
const LOCAL_BRANCH = "working-tree";
/** No id: no Studio org behind this editor (see the file comment). */
const NO_ORG = { id: "", slug: "", name: "", logo: null };
const LOCAL_PROJECT = { id: LOCAL_PROJECT_ID, slug: LOCAL_PROJECT_ID };

/** No thread and no chat: nothing here opens or creates one. */
const LOCAL_TASK: ChatTaskContextValue = {
  virtualMcpId: LOCAL_PROJECT_ID,
  taskId: null,
  openTask: () => {},
  createTask: () => "",
  createTaskWithMessage: () => {},
  activeTask: null,
  isThreadLocked: false,
  lockedHarness: null,
  lockedBranch: null,
  currentBranch: LOCAL_BRANCH,
  setCurrentTaskBranch: () => {},
};

function takeConnectionFromUrl(): DecoServeConnection | null {
  const fromLink = parseConnectFragment(window.location.hash);
  if (fromLink) {
    saveTabConnection(fromLink);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    return fromLink;
  }
  return readTabConnection();
}

const TABS = [
  { id: "site-editor", to: "/site-editor", label: "preview" },
  { id: "content", to: "/site-editor/content", label: "content" },
] as const;

function SiteEditorTabs() {
  const t = useT();
  const view = useRouterState({
    select: (state) => state.matches.at(-1)?.staticData.siteEditorView,
  });
  return (
    <Page.Tabs>
      {TABS.map((tab) => (
        <Page.Tab
          key={tab.id}
          asChild
          active={(view === "content") === (tab.id === "content")}
        >
          <Link to={tab.to} activeOptions={{ exact: true }}>
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center"
            >
              <TabIconGlyph
                icon={resolveTabIcon({
                  tabId: tab.id,
                  kind: "system",
                  connections: [],
                })}
              />
            </span>
            {t(`common.mainPanelTabs.${tab.label}`)}
          </Link>
        </Page.Tab>
      ))}
    </Page.Tabs>
  );
}

/** Holds the editor until the local server answers its probe. */
function BackendGate({
  connection,
  children,
}: {
  connection: DecoServeConnection;
  children: ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const backend = useContentBackend(LOCAL_PROJECT_ID, LOCAL_BRANCH);
  if (backend.kind === "protocol") return children;
  if (backend.kind === "pending") {
    return (
      <Centered>
        <Spinner className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.reaching", { endpoint: connection.endpoint })}
        </p>
      </Centered>
    );
  }
  // `unavailable`: the probe retries on its own; this retries now.
  return (
    <Centered>
      <p role="alert" className="text-sm text-destructive">
        {backend.kind === "unavailable" && backend.reason === "unauthorized"
          ? t("decoServe.status.unauthorized")
          : t("decoServe.status.unreachable")}
      </p>
      <Button
        variant="outline"
        onClick={() =>
          queryClient.invalidateQueries({ queryKey: KEYS.contentBackend() })
        }
      >
        {t("decoServe.connect.retry")}
      </Button>
    </Centered>
  );
}

function LocalSiteEditor({ connection }: { connection: DecoServeConnection }) {
  const t = useT();
  const { data: session } = authClient.useSession();
  return (
    <Layout outsideOrg={{ rail: !!session?.user }}>
      <Layout.Content>
        <div className="flex min-h-0 min-w-0 flex-1 p-1.5">
          <Panel data-testid="main-panel" className="flex-1">
            <Page.Breadcrumbs.Provider>
              <Page.Header
                breadcrumbs={[
                  {
                    key: "page",
                    label: t("sidebar.projectNav.siteEditor"),
                  },
                ]}
                navigation={<SiteEditorTabs />}
                actions={
                  <>
                    <ContentVersionBadge
                      virtualMcpId={LOCAL_PROJECT_ID}
                      branch={LOCAL_BRANCH}
                    />
                    <DecoServeChip
                      virtualMcpId={LOCAL_PROJECT_ID}
                      branch={LOCAL_BRANCH}
                    />
                  </>
                }
              />
              <Panel.Content>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <BackendGate connection={connection}>
                    <Outlet />
                  </BackendGate>
                </div>
              </Panel.Content>
            </Page.Breadcrumbs.Provider>
          </Panel>
        </div>
      </Layout.Content>
    </Layout>
  );
}

export default function SiteEditorRoute() {
  const t = useT();
  const [connection, setConnection] = useState(takeConnectionFromUrl);
  if (!connection) {
    return (
      <Centered fullScreen>
        <h1 className="text-lg font-medium text-foreground">
          {t("decoServe.connect.invalidLinkTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.invalidLinkDescription")}
        </p>
      </Centered>
    );
  }
  const state: DecoServeConnectionState = {
    connection,
    set: (next) => {
      saveTabConnection(next);
      setConnection(next);
    },
    clear: () => {
      clearTabConnection();
      setConnection(null);
    },
  };
  return (
    <ProjectContextProvider org={NO_ORG} project={LOCAL_PROJECT}>
      <TabDecoServeConnectionContext.Provider value={state}>
        <ChatTaskValueProvider value={LOCAL_TASK}>
          <BlocksPreviewWorkspaceProvider>
            <LocalSiteEditor connection={connection} />
          </BlocksPreviewWorkspaceProvider>
        </ChatTaskValueProvider>
      </TabDecoServeConnectionContext.Provider>
    </ProjectContextProvider>
  );
}

/** The Preview tab: the app `deco serve --preview` names, with Blocks. */
export function SiteEditorPreview() {
  return <PreviewContent virtualMcpId={LOCAL_PROJECT_ID} />;
}

/** The Content tab. */
export function SiteEditorContent() {
  return <ContentBrowser />;
}

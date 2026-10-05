/**
 * `/site-editor#endpoint=…` — the site editor over the `deco serve`
 * on this machine (the link the Blocks CLI prints), without a project.
 *
 * It is not gated, and it always renders in the New Layout, whatever this
 * person's preference says (`ForceProjectFirstNav`, scoped to this route). It
 * is the Site Editor APP, the same one a project launches
 * (`routes/workspace/agent-site-editor.tsx` and its Preview/Content tabs), in
 * the same app takeover: the org rail (signed in
 * only, as there are no orgs to list otherwise), no sidebar, the app full
 * screen. What needs Studio's hosting is left out: chat, GitHub, drafts,
 * publishing and Code. There is no org, so no recent app is recorded; the
 * rail still marks the Site Editor as the open app (`staticData.local`).
 *
 * `deco serve` has no token: the link carries only its endpoint (a `token=`
 * in an older link is ignored). The endpoint leaves the fragment at once and
 * is remembered in this browser, so `/site-editor` with no link reconnects to
 * the last one. While the server is down or restarting the editor waits for
 * it and reconnects on its own. Only loopback servers are accepted
 * (`parseConnectFragment`).
 *
 * The editor expects a project and a chat task: it gets a placeholder project,
 * in an org with no id (which makes the Studio-backed reads skip themselves),
 * and a task with no thread. The connection reaches every surface through
 * `TabDecoServeConnectionContext`.
 */

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  ChatTaskValueProvider,
  type ChatTaskContextValue,
} from "@/components/chat/context";
import { ChatLayout } from "@/components/chat-layout";
import { Layout } from "@/components/layout";
import { Page } from "@/components/page";
import { BlocksPreviewWorkspaceProvider } from "@/components/sandbox/blocks/blocks-preview-workspace-context";
import { ConnectCentered as Centered } from "@/components/sections-editor/deco-serve-chip";
import {
  type DecoServeConnection,
  clearLastConnection,
  endpointHost,
  parseConnectFragment,
  readLastConnection,
  saveLastConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import {
  type DecoServeConnectionState,
  TabDecoServeConnectionContext,
  useDecoServeConnection,
} from "@/hooks/use-deco-serve-connection";
import { ForceProjectFirstNav } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import { ContentTab } from "@/layouts/main-panel-tabs/content-tab";
import { PreviewTab } from "@/layouts/main-panel-tabs/preview-tab";
import { TabIconGlyph } from "@/layouts/main-panel-tabs/tab-icon-glyph";
import { resolveTabIcon } from "@/layouts/main-panel-tabs/resolve-tab-icon";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import SiteEditorApp from "@/routes/workspace/agent-site-editor";
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

/** The link's endpoint (then remembered), else the last one remembered. */
function takeConnectionFromUrl(): DecoServeConnection | null {
  const hash = window.location.hash;
  if (!new URLSearchParams(hash.replace(/^#/, "")).has("endpoint")) {
    return readLastConnection();
  }
  // A link that names a server is used as is: an invalid one never falls
  // back to another server.
  const fromLink = parseConnectFragment(hash);
  if (fromLink) {
    saveLastConnection(fromLink);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return fromLink;
}

/** The app's own Preview/Content tabs, as the project tab bar draws them
 *  (`MainPanelTabsBar` reads a project's views, and there is none here). */
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
function BackendGate({ children }: { children: ReactNode }) {
  const t = useT();
  const { connection } = useDecoServeConnection(LOCAL_PROJECT_ID);
  const queryClient = useQueryClient();
  const backend = useContentBackend(LOCAL_PROJECT_ID, LOCAL_BRANCH);
  if (backend.kind === "protocol") return children;
  if (backend.kind === "pending") {
    return (
      <Centered>
        <Spinner className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.reaching", {
            endpoint: connection?.endpoint ?? "",
          })}
        </p>
      </Centered>
    );
  }
  // `unavailable`: the probe retries on its own; this retries now.
  return (
    <Centered>
      <Spinner className="size-6 text-muted-foreground" />
      <p role="status" className="text-sm text-foreground">
        {t("decoServe.status.waiting", {
          host: connection ? endpointHost(connection.endpoint) : "",
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("decoServe.status.unreachable")}
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

/** Chat stays closed: there is no thread outside a project. */
const NO_CHAT = {
  threadOpen: false,
  contentOpen: true,
  threadVisibilityExplicit: false,
  toggleThread: () => {},
  toggleContent: () => {},
};

/** The app takeover a project's launched app gets, around the same app. */
function LocalSiteEditor() {
  const { data: session } = authClient.useSession();
  const view = useRouterState({
    select: (state) => state.matches.at(-1)?.staticData.siteEditorView,
  });
  return (
    <Layout outsideOrg={{ rail: !!session?.user }}>
      <Layout.Content>
        <ChatLayout
          {...NO_CHAT}
          threadless
          contentKey={view ?? "preview"}
          contentNavigation={<SiteEditorTabs />}
        >
          <ChatLayout.Thread>{null}</ChatLayout.Thread>
          <SiteEditorApp />
        </ChatLayout>
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
      saveLastConnection(next);
      setConnection(next);
    },
    clear: () => {
      clearLastConnection();
      setConnection(null);
    },
  };
  return (
    <ForceProjectFirstNav value>
      <ProjectContextProvider org={NO_ORG} project={LOCAL_PROJECT}>
        <TabDecoServeConnectionContext.Provider value={state}>
          <ChatTaskValueProvider value={LOCAL_TASK}>
            <BlocksPreviewWorkspaceProvider>
              <LocalSiteEditor />
            </BlocksPreviewWorkspaceProvider>
          </ChatTaskValueProvider>
        </TabDecoServeConnectionContext.Provider>
      </ProjectContextProvider>
    </ForceProjectFirstNav>
  );
}

/** The Preview tab: the app `deco serve --preview` names, with Blocks. */
export function SiteEditorPreview() {
  return (
    <BackendGate>
      <PreviewTab virtualMcpId={LOCAL_PROJECT_ID} />
    </BackendGate>
  );
}

/** The Content tab. */
export function SiteEditorContent() {
  return (
    <BackendGate>
      <ContentTab virtualMcpId={LOCAL_PROJECT_ID} />
    </BackendGate>
  );
}

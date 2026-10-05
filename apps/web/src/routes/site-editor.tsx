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
 * is remembered in this browser. With no link, the page shows a guide
 * (`SiteEditorGuide`) and looks for `deco serve` on its own: the last server
 * used, then the default port. Disconnecting keeps that server out of the
 * search for the rest of the session. While the server is down or restarting
 * the editor waits for it and reconnects on its own, explaining why it
 * waits. Only loopback servers are accepted (`parseConnectFragment`).
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
  isLoopbackEndpoint,
  markDisconnected,
  needsAllowOrigin,
  parseConnectFragment,
  readLastConnection,
  SCHEMA_COMMAND,
  saveLastConnection,
  serveCommand,
  unmarkDisconnected,
} from "@/components/sections-editor/deco-serve-connection";
import {
  CommandSnippet,
  DocsLinks,
  RichCode,
  serveProblemCopy,
} from "@/components/sections-editor/deco-serve-notices";
import { SiteEditorGuide } from "@/components/sections-editor/site-editor-guide";
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

interface RouteStart {
  connection: DecoServeConnection | null;
  /** The page was opened with a link that isn't a usable one. */
  invalidLink: boolean;
}

/**
 * The link's endpoint (then remembered). With no link, nothing yet: the
 * guide looks for the last server used and the default port on its own.
 */
function takeConnectionFromUrl(): RouteStart {
  const hash = window.location.hash;
  if (!new URLSearchParams(hash.replace(/^#/, "")).has("endpoint")) {
    return { connection: null, invalidLink: false };
  }
  // A link that names a server is used as is: an invalid one never falls
  // back to another server.
  const fromLink = parseConnectFragment(hash);
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
  if (!fromLink) return { connection: null, invalidLink: true };
  saveLastConnection(fromLink);
  unmarkDisconnected(fromLink.endpoint);
  return { connection: fromLink, invalidLink: false };
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

/** A connection problem, centered in the editor's frame, scrolling when tall. */
function GateFrame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-center gap-4 px-4 py-10">
        {children}
      </div>
    </div>
  );
}

/**
 * Holds the editor until the local server answers its probe, and explains
 * why when it doesn't: stopped or restarting, out of date, another program
 * on the port, or no schema generated yet.
 */
function BackendGate({ children }: { children: ReactNode }) {
  const t = useT();
  const { connection, clear } = useDecoServeConnection(LOCAL_PROJECT_ID);
  const queryClient = useQueryClient();
  const backend = useContentBackend(LOCAL_PROJECT_ID, LOCAL_BRANCH);
  const host = connection ? endpointHost(connection.endpoint) : "";
  const origin = window.location.origin;
  const retry = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.contentBackend() });

  if (backend.kind === "protocol") {
    if (backend.source !== "local" || backend.hasSchema !== false) {
      return children;
    }
    return (
      <GateFrame>
        <h2 className="text-base font-medium text-foreground">
          {t("decoServe.schemaMissing.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          <RichCode text={t("decoServe.schemaMissing.body")} />
        </p>
        <CommandSnippet command={SCHEMA_COMMAND} />
        <DocsLinks links={["schema", "troubleshooting"]} />
      </GateFrame>
    );
  }
  if (backend.kind === "pending") {
    return (
      <Centered>
        <Spinner className="size-6 text-muted-foreground" />
        <p role="status" className="text-sm text-muted-foreground">
          {t("decoServe.connect.reaching", { host })}
        </p>
      </Centered>
    );
  }
  // `unavailable`: the probe retries on its own; "Try now" retries at once.
  const problem =
    backend.kind === "unavailable" && backend.problem
      ? backend.problem
      : { reason: "not-answering" as const };
  const { title, body } = serveProblemCopy(t, problem, host);
  const notAnswering = problem.reason === "not-answering";
  return (
    <GateFrame>
      <div role="status" className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-base font-medium text-foreground">
          {notAnswering && <Spinner className="size-4 text-muted-foreground" />}
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">
          <RichCode text={body} />
        </p>
      </div>
      {notAnswering && (
        <>
          <p className="text-sm text-muted-foreground">
            {t("decoServe.state.notAnswering.next")}
          </p>
          <CommandSnippet command={serveCommand(origin)} />
          {needsAllowOrigin(origin) && (
            <p className="text-sm text-muted-foreground">
              <RichCode
                text={t("decoServe.state.notAnswering.origin", { origin })}
              />
            </p>
          )}
          {!isLoopbackEndpoint(origin) && (
            <p className="text-sm text-muted-foreground">
              {t("decoServe.state.notAnswering.lna")}
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void retry()}>
          {t("decoServe.state.tryNow")}
        </Button>
        <Button variant="ghost" onClick={clear}>
          {t("decoServe.state.useAnother")}
        </Button>
      </div>
      <DocsLinks links={["troubleshooting", "serve"]} />
    </GateFrame>
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

/** Before a connection: the guide, in the same app shell as the editor. */
function LocalSiteEditorGuide(props: Parameters<typeof SiteEditorGuide>[0]) {
  const { data: session } = authClient.useSession();
  return (
    <Layout outsideOrg={{ rail: !!session?.user }}>
      <Layout.Content>
        <SiteEditorGuide {...props} />
      </Layout.Content>
    </Layout>
  );
}

export default function SiteEditorRoute() {
  const [start] = useState(takeConnectionFromUrl);
  const [connection, setConnection] = useState(start.connection);
  const [invalidLink, setInvalidLink] = useState(start.invalidLink);
  const [disconnectedFrom, setDisconnectedFrom] = useState<string | null>(null);
  const state: DecoServeConnectionState = {
    connection,
    set: (next) => {
      saveLastConnection(next);
      unmarkDisconnected(next.endpoint);
      setInvalidLink(false);
      setDisconnectedFrom(null);
      setConnection(next);
    },
    clear: () => {
      // Not found again on its own in this session, or Disconnect would
      // reconnect at once.
      if (connection) markDisconnected(connection.endpoint);
      clearLastConnection();
      setDisconnectedFrom(connection?.endpoint ?? null);
      setConnection(null);
    },
  };
  return (
    <ForceProjectFirstNav value>
      <ProjectContextProvider org={NO_ORG} project={LOCAL_PROJECT}>
        <TabDecoServeConnectionContext.Provider value={state}>
          {connection ? (
            <ChatTaskValueProvider value={LOCAL_TASK}>
              <BlocksPreviewWorkspaceProvider>
                <LocalSiteEditor />
              </BlocksPreviewWorkspaceProvider>
            </ChatTaskValueProvider>
          ) : (
            <LocalSiteEditorGuide
              remembered={readLastConnection()}
              invalidLink={invalidLink}
              disconnectedFrom={disconnectedFrom}
              onConnect={state.set}
            />
          )}
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

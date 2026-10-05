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
 * One rule (`LocalServeSwitch`): it looks for `deco serve` at the link's
 * endpoint, or else the last one used and the default port
 * (`serveCandidates`). If it answers, the editor opens; if not, the guide
 * (`SiteEditorGuide`) shows and keeps looking, and the editor opens as soon
 * as it answers. When the server stops answering while editing, the guide
 * comes back until it does. There is no Disconnect.
 *
 * `deco serve` has no token: the link carries only its endpoint (a `token=`
 * in an older link is ignored). The endpoint leaves the fragment at once and
 * is remembered in this browser. Only loopback servers are accepted
 * (`parseConnectFragment`).
 *
 * The editor expects a project and a chat task: it gets a placeholder project,
 * in an org with no id (which makes the Studio-backed reads skip themselves),
 * and a task with no thread. The connection reaches every surface through
 * `TabDecoServeConnectionContext`.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
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
  endpointHost,
  parseConnectFragment,
  readLastConnection,
  SCHEMA_COMMAND,
  saveLastConnection,
  serveCandidates,
} from "@/components/sections-editor/deco-serve-connection";
import {
  CommandSnippet,
  DocsLinks,
  RichCode,
  serveProblemCopy,
} from "@/components/sections-editor/deco-serve-notices";
import {
  isServeLost,
  LocalServeSwitch,
} from "@/components/sections-editor/site-editor-guide";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import {
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
  /** Where to look for `deco serve` (see `serveCandidates`). */
  candidates: string[];
  /** The page was opened with a link that isn't a usable one. */
  invalidLink: boolean;
}

/**
 * Takes the link's endpoint out of the address bar (and remembers it): it is
 * the only place looked at. With no usable link, the last one used and the
 * default port.
 */
function takeStartFromUrl(): RouteStart {
  const hash = window.location.hash;
  const hasLink = new URLSearchParams(hash.replace(/^#/, "")).has("endpoint");
  const fromLink = hasLink ? parseConnectFragment(hash) : null;
  if (hasLink) {
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  if (fromLink) saveLastConnection(fromLink);
  return {
    candidates: serveCandidates(fromLink, readLastConnection()),
    invalidLink: hasLink && !fromLink,
  };
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
 * why when it answered but can't be used: out of date, another version,
 * another program on the port, an error, or no schema generated yet. A server
 * that stops answering takes the route back to its guide (`ServeLostWatcher`).
 */
function BackendGate({ children }: { children: ReactNode }) {
  const t = useT();
  const { connection } = useDecoServeConnection(LOCAL_PROJECT_ID);
  const backend = useContentBackend(LOCAL_PROJECT_ID, LOCAL_BRANCH);
  const host = connection ? endpointHost(connection.endpoint) : "";

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
  if (backend.kind !== "unavailable" || isServeLost(backend)) {
    return (
      <Centered>
        <Spinner className="size-6 text-muted-foreground" />
        <p role="status" className="text-sm text-muted-foreground">
          {t("decoServe.connect.reaching", { host })}
        </p>
      </Centered>
    );
  }
  // It answered, but can't be used; the probe keeps polling on its own.
  const { title, body } = serveProblemCopy(
    t,
    backend.problem ?? { reason: "not-answering" },
    host,
  );
  return (
    <GateFrame>
      <div role="status" className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">
          <RichCode text={body} />
        </p>
      </div>
      <DocsLinks links={["troubleshooting", "serve"]} />
    </GateFrame>
  );
}

/** Calls `onLost` when the editor's server stops answering. */
function ServeLostWatcher({ onLost }: { onLost: () => void }) {
  const backend = useContentBackend(LOCAL_PROJECT_ID, LOCAL_BRANCH);
  const lost = isServeLost(backend);
  // The probe is an outside system: its failure hands the route back to the
  // guide, which owns the search from there.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (lost) onLost();
  }, [lost, onLost]);
  return null;
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
function LocalSiteEditorGuide({ children }: { children: ReactNode }) {
  const { data: session } = authClient.useSession();
  return (
    <Layout outsideOrg={{ rail: !!session?.user }}>
      <Layout.Content>
        <ChatLayout {...NO_CHAT} threadless contentKey="guide">
          <ChatLayout.Thread>{null}</ChatLayout.Thread>
          <ChatLayout.Content>{children}</ChatLayout.Content>
        </ChatLayout>
      </Layout.Content>
    </Layout>
  );
}

/** Nothing on `/site-editor` changes the server: it follows the rule above. */
const noop = () => {};
const NOT_CONNECTED = { connection: null, set: noop, clear: noop };

export default function SiteEditorRoute() {
  const [start] = useState(takeStartFromUrl);
  return (
    <ForceProjectFirstNav value>
      <ProjectContextProvider org={NO_ORG} project={LOCAL_PROJECT}>
        <LocalServeSwitch
          candidates={start.candidates}
          invalidLink={start.invalidLink}
          shell={(guide) => (
            <TabDecoServeConnectionContext.Provider value={NOT_CONNECTED}>
              <LocalSiteEditorGuide>{guide}</LocalSiteEditorGuide>
            </TabDecoServeConnectionContext.Provider>
          )}
          editor={(connection, onLost) => (
            <TabDecoServeConnectionContext.Provider
              value={{ connection, set: noop, clear: noop }}
            >
              <ServeLostWatcher onLost={onLost} />
              <ChatTaskValueProvider value={LOCAL_TASK}>
                <BlocksPreviewWorkspaceProvider>
                  <LocalSiteEditor />
                </BlocksPreviewWorkspaceProvider>
              </ChatTaskValueProvider>
            </TabDecoServeConnectionContext.Provider>
          )}
        />
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

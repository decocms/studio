/**
 * `/site-editor#endpoint=…&token=…` — the account-less site editor over the
 * `deco serve` on this machine (the link the Blocks CLI prints). No sign-in,
 * no org, no project, no GitHub: just the editor, talking the content
 * protocol to the local server, which writes the working tree.
 *
 * The connection leaves the fragment at once (so the token never stays in
 * the address bar or history) and is kept for this tab only. Only loopback
 * servers are accepted (`parseConnectFragment`).
 *
 * The editor components expect a project: they get a placeholder one, with
 * an org that has no id, which is what makes the Studio-backed reads (the
 * project row, org flags) skip themselves. The connection reaches every
 * surface through `TabDecoServeConnectionContext`.
 */

import { Suspense, lazy, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  type DecoServeConnection,
  clearTabConnection,
  parseConnectFragment,
  readTabConnection,
  saveTabConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { ConnectCentered as Centered } from "@/components/sections-editor/deco-serve-chip";
import { ContentVersionBadge } from "@/components/sections-editor/content-version-badge";
import {
  extractGlobalSections,
  extractPages,
} from "@/components/sections-editor/page-list";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import { useDecofile } from "@/components/sections-editor/use-decofile";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import {
  type DecoServeConnectionState,
  TabDecoServeConnectionContext,
} from "@/hooks/use-deco-serve-connection";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { ProjectContextProvider } from "@/sdk";

const SectionsEditor = lazy(() =>
  import("@/components/sections-editor/sections-editor").then((m) => ({
    default: m.SectionsEditor,
  })),
);

/** Stands in for the project id every editor hook is keyed by. */
const LOCAL_PROJECT_ID = "deco-serve";
/** No id: no Studio org behind this editor (see the file comment). */
const NO_ORG = { id: "", slug: "", name: "", logo: null };
const LOCAL_PROJECT = { id: LOCAL_PROJECT_ID, slug: LOCAL_PROJECT_ID };

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

type Selection =
  | { kind: "page"; key: string; path: string }
  | { kind: "section"; key: string };

function SidebarGroup({
  title,
  items,
  selectedKey,
  onSelect,
}: {
  title: string;
  items: { key: string; name: string; detail?: string }[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">
        {title}
      </h2>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect(item.key)}
          className={cn(
            "flex min-w-0 flex-col rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
            item.key === selectedKey && "bg-accent",
          )}
        >
          <span className="truncate text-foreground">{item.name}</span>
          {item.detail && (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {item.detail}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function LocalSiteEditor({
  connection,
  onDisconnect,
}: {
  connection: DecoServeConnection;
  onDisconnect: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const backend = useContentBackend(LOCAL_PROJECT_ID, "");
  const params = {
    orgSlug: "",
    virtualMcpId: LOCAL_PROJECT_ID,
    branch: "",
    threadId: null,
  };
  const decofile = useDecofile(params).data;
  const meta = useLiveMeta(params).data;
  const [selection, setSelection] = useState<Selection | null>(null);

  if (backend.kind === "pending") {
    return (
      <Centered fullScreen>
        <Spinner className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.reaching", { endpoint: connection.endpoint })}
        </p>
      </Centered>
    );
  }
  if (backend.kind !== "protocol") {
    // `unavailable`: the probe retries on its own; this retries now.
    return (
      <Centered fullScreen>
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

  const pages =
    decofile && meta
      ? extractPages(decofile, meta).sort((a, b) =>
          a.path.localeCompare(b.path),
        )
      : [];
  const sections =
    decofile && meta
      ? extractGlobalSections(decofile, meta).sort((a, b) =>
          a.name.localeCompare(b.name),
        )
      : [];
  // Lands on the home page until something else is picked.
  const home = pages.find((p) => p.path === "/") ?? pages[0];
  const current: Selection | null =
    selection ??
    (home ? { kind: "page", key: home.key, path: home.path } : null);
  const previewOrigin = backend.describe.preview?.origin;

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="text-sm font-medium text-foreground">
          {t("decoServe.siteEditor.title")}
        </h1>
        <ContentVersionBadge virtualMcpId={LOCAL_PROJECT_ID} branch="" />
        <span
          data-testid="deco-serve-connect-target"
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
        >
          {backend.describe.root} · {connection.endpoint}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {previewOrigin && (
            <Button variant="ghost" size="sm" asChild>
              <a
                href={new URL(
                  current?.kind === "page" ? current.path : "/",
                  previewOrigin,
                ).toString()}
                target="_blank"
                rel="noreferrer"
              >
                {t("decoServe.siteEditor.openSite")}
              </a>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDisconnect}>
            {t("decoServe.chip.disconnect")}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-64 shrink-0 overflow-y-auto border-r border-border p-2">
          {!decofile || !meta ? (
            <div className="flex justify-center p-4">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          ) : (
            <>
              <SidebarGroup
                title={t("decoServe.siteEditor.pages")}
                items={pages.map((p) => ({
                  key: p.key,
                  name: p.name,
                  detail: p.path,
                }))}
                selectedKey={current?.kind === "page" ? current.key : null}
                onSelect={(key) => {
                  const page = pages.find((p) => p.key === key);
                  if (page)
                    setSelection({ kind: "page", key, path: page.path });
                }}
              />
              <SidebarGroup
                title={t("decoServe.siteEditor.sections")}
                items={sections}
                selectedKey={current?.kind === "section" ? current.key : null}
                onSelect={(key) => setSelection({ kind: "section", key })}
              />
            </>
          )}
        </nav>
        <main className="min-w-0 flex-1">
          {current ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner className="size-5 text-muted-foreground" />
                </div>
              }
            >
              <SectionsEditor
                key={`${current.kind}:${current.key}`}
                orgSlug=""
                virtualMcpId={LOCAL_PROJECT_ID}
                branch=""
                currentPath={current.kind === "page" ? current.path : "/"}
                activePageBlockKey={
                  current.kind === "page" ? current.key : null
                }
                activeGlobalBlockKey={
                  current.kind === "section" ? current.key : null
                }
                onSelectRoot={() => setSelection(null)}
              />
            </Suspense>
          ) : (
            decofile &&
            meta && (
              <Centered>
                <p className="text-sm text-muted-foreground">
                  {t("decoServe.siteEditor.empty")}
                </p>
              </Centered>
            )
          )}
        </main>
      </div>
    </div>
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
  const disconnect = () => {
    clearTabConnection();
    setConnection(null);
  };
  const state: DecoServeConnectionState = {
    connection,
    set: (next) => {
      saveTabConnection(next);
      setConnection(next);
    },
    clear: disconnect,
  };
  return (
    <ProjectContextProvider org={NO_ORG} project={LOCAL_PROJECT}>
      <TabDecoServeConnectionContext.Provider value={state}>
        <LocalSiteEditor connection={connection} onDisconnect={disconnect} />
      </TabDecoServeConnectionContext.Provider>
    </ProjectContextProvider>
  );
}

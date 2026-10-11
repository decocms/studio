/**
 * `/site-editor`'s one rule: while `deco serve` answers, the editor; while it
 * doesn't, this guide, which keeps looking for it (backing off, paused while
 * the tab is hidden) and opens the editor as soon as it answers. The guide
 * explains what the site editor is and how to start `deco serve`.
 */

import { type ReactNode, useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { useDecoServeDiscovery } from "@/hooks/use-deco-serve-discovery";
import { usePreferences } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import type { ContentBackend } from "./content-backend";
import {
  type DecoServeConnection,
  endpointHost,
  SERVE_COMMAND,
} from "./deco-serve-connection";
import {
  DocsLinks,
  RichCode,
  LocalNetworkDeniedAlert,
  ServeProblemAlert,
} from "./deco-serve-notices";
import { ConnectionWire, ServeConnectState } from "./serve-connect-state";

/** The editor's server stopped answering: back to the guide until it's back. */
export function isServeLost(backend: ContentBackend): boolean {
  return (
    backend.kind === "unavailable" &&
    backend.source === "local" &&
    (backend.problem?.reason ?? "not-answering") === "not-answering"
  );
}

const bare = (guide: ReactNode) => guide;

/**
 * The guide until one of `candidates` answers, then `editor`, until it calls
 * `onLost` (the server stopped answering), then the guide again.
 */
export function LocalServeSwitch({
  candidates,
  invalidLink = false,
  shell = bare,
  editor,
}: {
  candidates: readonly string[];
  /** The page was opened with a link that isn't a usable one. */
  invalidLink?: boolean;
  /** Frames the guide (the app shell). */
  shell?: (guide: ReactNode) => ReactNode;
  editor: (connection: DecoServeConnection, onLost: () => void) => ReactNode;
}) {
  const [connection, setConnection] = useState<DecoServeConnection | null>(
    null,
  );
  if (connection) return editor(connection, () => setConnection(null));
  return shell(
    <SiteEditorGuide
      candidates={candidates}
      invalidLink={invalidLink}
      onConnect={setConnection}
    />,
  );
}

export function SiteEditorGuide({
  candidates,
  invalidLink = false,
  onConnect,
}: {
  /** The endpoints looked for, in order (see `serveCandidates`). */
  candidates: readonly string[];
  /** The page was opened with a link that isn't a usable one. */
  invalidLink?: boolean;
  onConnect: (connection: DecoServeConnection) => void;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const discovery = useDecoServeDiscovery({
    candidates,
    onFound: (endpoint) => onConnect({ endpoint }),
  });
  const { state, access, needsGesture } = discovery;
  const hosts = new Intl.ListFormat(language, {
    style: "long",
    type: "conjunction",
  }).format(candidates.map(endpointHost));

  // While the first look runs, a short "Looking…", not a flash of the guide
  // before the editor opens.
  const firstLook =
    !invalidLink &&
    access !== "denied" &&
    !needsGesture &&
    !state.firstRoundDone &&
    state.status !== "found";
  if (firstLook) {
    return (
      <div
        role="status"
        className="flex h-full w-full flex-col items-center justify-center gap-3 p-6"
      >
        <ConnectionWire waiting />
        <p className="text-sm text-muted-foreground">
          {t("decoServe.guide.checkingFirst")}
        </p>
      </div>
    );
  }

  const looking = !needsGesture && access !== "denied";
  return (
    <ServeConnectState
      title={t("decoServe.guide.title")}
      lead={t("decoServe.guide.lead")}
      waiting={looking && state.status !== "paused" && !state.problem}
      alerts={
        <>
          {invalidLink && (
            <Alert variant="warning">
              <div className="flex min-w-0 flex-col gap-1">
                <AlertTitle className="line-clamp-none text-foreground">
                  {t("decoServe.link.invalidTitle")}
                </AlertTitle>
                <AlertDescription>
                  {t("decoServe.link.invalidBody")}
                </AlertDescription>
              </div>
            </Alert>
          )}
          {access === "denied" && <LocalNetworkDeniedAlert />}
        </>
      }
      steps={[
        {
          title: t("decoServe.guide.step1.title"),
          body: <RichCode text={t("decoServe.guide.step1.body")} />,
          command: SERVE_COMMAND,
          after: (
            <p className="text-sm text-muted-foreground">
              <RichCode text={t("decoServe.guide.step1.preview")} />
            </p>
          ),
        },
        {
          title: t("decoServe.guide.step2.title"),
          body: t("decoServe.guide.step2.body"),
          after: (
            <>
              {state.problem && (
                <ServeProblemAlert
                  problem={state.problem}
                  host={endpointHost(state.problem.endpoint)}
                />
              )}
              {needsGesture ? (
                <Button
                  variant="outline"
                  className="self-start"
                  onClick={discovery.start}
                >
                  {t("decoServe.guide.step2.start")}
                </Button>
              ) : (
                looking && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {state.status === "paused"
                      ? t("decoServe.guide.step2.paused")
                      : t("decoServe.guide.step2.looking", { hosts })}
                  </p>
                )
              )}
            </>
          ),
        },
      ]}
      footer={
        <>
          <p className="text-sm text-muted-foreground">
            {t("decoServe.guide.v7")}
          </p>
          <DocsLinks
            className="border-t border-border pt-4"
            links={["quickstart", "siteEditor", "serve", "troubleshooting"]}
          />
        </>
      }
    />
  );
}

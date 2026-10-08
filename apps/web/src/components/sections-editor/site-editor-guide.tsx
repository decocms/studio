/**
 * `/site-editor`'s one rule: while `deco serve` answers, the editor; while it
 * doesn't, this guide, which keeps looking for it (backing off, paused while
 * the tab is hidden) and opens the editor as soon as it answers. The guide
 * explains what the site editor is and how to start `deco serve`.
 */

import { type ReactNode, useId, useState } from "react";
import { Monitor04 } from "@untitledui/icons";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
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
  CommandSnippet,
  DocsLinks,
  RichCode,
  ServeProblemAlert,
} from "./deco-serve-notices";

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

function Step({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <li
      aria-labelledby={headingId}
      className="surface flex flex-col gap-3 p-4 sm:p-5"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-foreground"
        >
          {index}
        </span>
        <h2 id={headingId} className="text-sm font-medium text-foreground">
          {title}
        </h2>
      </div>
      <div className="flex min-w-0 flex-col gap-3 sm:pl-9">{children}</div>
    </li>
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
        <Spinner className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t("decoServe.guide.checkingFirst")}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:py-12">
        <header className="flex flex-col items-center gap-3 text-center">
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground sm:size-12"
          >
            <Monitor04 className="size-5 sm:size-6" />
          </span>
          <h1
            tabIndex={-1}
            className="text-balance text-lg font-medium text-foreground outline-none sm:text-xl"
          >
            {t("decoServe.guide.title")}
          </h1>
          <p className="text-pretty text-sm text-muted-foreground">
            {t("decoServe.guide.lead")}
          </p>
        </header>

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
        {access === "denied" && (
          <Alert variant="destructive">
            <div className="flex min-w-0 flex-col gap-1">
              <AlertTitle className="line-clamp-none">
                {t("decoServe.lna.deniedTitle")}
              </AlertTitle>
              <AlertDescription>
                {t("decoServe.lna.deniedBody")}
              </AlertDescription>
            </div>
          </Alert>
        )}

        <ol className="flex flex-col gap-3">
          <Step index={1} title={t("decoServe.guide.step1.title")}>
            <p className="text-sm text-muted-foreground">
              <RichCode text={t("decoServe.guide.step1.body")} />
            </p>
            <CommandSnippet command={SERVE_COMMAND} />
            <p className="text-sm text-muted-foreground">
              <RichCode text={t("decoServe.guide.step1.preview")} />
            </p>
          </Step>

          <Step index={2} title={t("decoServe.guide.step2.title")}>
            <p className="text-sm text-muted-foreground">
              {t("decoServe.guide.step2.body")}
            </p>
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
              access !== "denied" && (
                <p
                  role="status"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  {state.status === "paused" ? (
                    t("decoServe.guide.step2.paused")
                  ) : (
                    <>
                      <Spinner className="size-4" />
                      {t("decoServe.guide.step2.looking", { hosts })}
                    </>
                  )}
                </p>
              )
            )}
          </Step>
        </ol>

        <p className="text-sm text-muted-foreground">
          {t("decoServe.guide.v7")}
        </p>

        <DocsLinks
          className="border-t border-border pt-4"
          links={["quickstart", "siteEditor", "serve", "troubleshooting"]}
        />
      </div>
    </div>
  );
}

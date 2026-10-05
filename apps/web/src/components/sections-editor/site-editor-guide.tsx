/**
 * `/site-editor` before it is connected: what the site editor is, and three
 * steps to get it running. Meanwhile it looks for `deco serve` on its own
 * (the last server used, then the default port) and hands the first one that
 * answers to `onConnect`, so starting `deco serve` is all it takes.
 */

import { type FormEvent, type ReactNode, useId, useState } from "react";
import { AlertCircle, Monitor04, SearchSm } from "@untitledui/icons";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  probeServeEndpoint,
  useDecoServeDiscovery,
} from "@/hooks/use-deco-serve-discovery";
import { usePreferences } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import {
  classifyServeProbeError,
  type DecoServeConnection,
  discoveryCandidates,
  endpointHost,
  needsAllowOrigin,
  parseServeAddress,
  readDisconnected,
  serveCommand,
} from "./deco-serve-connection";
import { DISCOVERY_PROBE_TIMEOUT_MS } from "./deco-serve-discovery";
import {
  CommandSnippet,
  DocsLinks,
  RichCode,
  ServeProblemAlert,
  serveProblemCopy,
} from "./deco-serve-notices";

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
    <li aria-labelledby={headingId} className="surface flex gap-4 p-5">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground"
      >
        {index}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h2 id={headingId} className="text-sm font-medium text-foreground">
          {title}
        </h2>
        {children}
      </div>
    </li>
  );
}

/** "Using another port?": a pasted link, address or port, probed once. */
function ManualConnect({
  onConnect,
}: {
  onConnect: (connection: DecoServeConnection) => void;
}) {
  const t = useT();
  const inputId = useId();
  const errorId = useId();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem(
      "address",
    ) as HTMLInputElement | null;
    const value = input?.value ?? "";
    if (!value.trim()) {
      input?.focus();
      return;
    }
    const parsed = parseServeAddress(value);
    if (!parsed.ok) {
      setError(
        parsed.reason === "not-local"
          ? t("decoServe.guide.step3.notLocal")
          : t("decoServe.guide.step3.unrecognized"),
      );
      input?.focus();
      return;
    }
    const { endpoint } = parsed.connection;
    const host = endpointHost(endpoint);
    setChecking(true);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DISCOVERY_PROBE_TIMEOUT_MS,
    );
    try {
      // A click: where Chrome asks to reach this machine, it asks now.
      await probeServeEndpoint(endpoint, controller.signal);
      onConnect(parsed.connection);
    } catch (failure) {
      const problem = classifyServeProbeError(failure);
      if (problem.reason === "not-answering") {
        setError(t("decoServe.guide.step3.noAnswer", { host }));
      } else {
        const { title, body } = serveProblemCopy(t, problem, host);
        setError(`${title}. ${body}`);
      }
      input?.focus();
    } finally {
      clearTimeout(timeout);
      setChecking(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-2"
    >
      <Label htmlFor={inputId}>{t("decoServe.guide.step3.label")}</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          name="address"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("decoServe.guide.step3.placeholder")}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          onChange={() => setError(null)}
        />
        <Button type="submit" variant="outline" disabled={checking}>
          {checking && <Spinner className="size-4" />}
          {checking
            ? t("decoServe.guide.step3.checking")
            : t("decoServe.guide.step3.submit")}
        </Button>
      </div>
      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-sm text-destructive"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <RichCode text={error} />
          </span>
        </p>
      )}
    </form>
  );
}

export function SiteEditorGuide({
  remembered,
  invalidLink = false,
  disconnectedFrom = null,
  onConnect,
}: {
  /** The last server used in this browser: looked for first. */
  remembered: DecoServeConnection | null;
  /** The page was opened with a link that isn't a usable one. */
  invalidLink?: boolean;
  /** The endpoint just disconnected from, offered back. */
  disconnectedFrom?: string | null;
  onConnect: (connection: DecoServeConnection) => void;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const origin = window.location.origin;
  const candidates = discoveryCandidates(remembered, readDisconnected());
  const discovery = useDecoServeDiscovery({
    candidates,
    enabled: true,
    onFound: (endpoint) => onConnect({ endpoint }),
  });
  const { state, access, needsGesture } = discovery;
  const hosts = new Intl.ListFormat(language, {
    style: "long",
    type: "conjunction",
  }).format(candidates.map(endpointHost));

  // A returning visitor sees a short "Looking…" while the remembered server
  // is probed, not a flash of the whole guide.
  const quietFirstRound =
    !!remembered &&
    !invalidLink &&
    !disconnectedFrom &&
    candidates.length > 0 &&
    access !== "denied" &&
    !needsGesture &&
    !state.firstRoundDone &&
    state.status !== "found";
  if (quietFirstRound) {
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
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-12">
        <header className="flex flex-col items-center gap-3 text-center">
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"
          >
            <Monitor04 className="size-6" />
          </span>
          <h1
            tabIndex={-1}
            className="text-xl font-medium text-foreground outline-none"
          >
            {t("decoServe.guide.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
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
        {disconnectedFrom && (
          <Alert variant="info" role="status">
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
              <AlertDescription className="text-foreground">
                {t("decoServe.guide.disconnected", {
                  host: endpointHost(disconnectedFrom),
                })}
              </AlertDescription>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onConnect({ endpoint: disconnectedFrom })}
              >
                {t("decoServe.guide.reconnect")}
              </Button>
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
        {state.problem && (
          <ServeProblemAlert
            problem={state.problem}
            host={endpointHost(state.problem.endpoint)}
          />
        )}

        <ol className="flex flex-col gap-3">
          <Step index={1} title={t("decoServe.guide.step1.title")}>
            <p className="text-sm text-muted-foreground">
              <RichCode text={t("decoServe.guide.step1.body")} />
            </p>
            <CommandSnippet command={serveCommand(origin)} />
            <p className="text-sm text-muted-foreground">
              <RichCode text={t("decoServe.guide.step1.preview")} />
            </p>
            {needsAllowOrigin(origin) && (
              <p className="text-sm text-muted-foreground">
                <RichCode
                  text={t("decoServe.guide.step1.origin", { origin })}
                />
              </p>
            )}
          </Step>

          <Step index={2} title={t("decoServe.guide.step2.title")}>
            <p className="text-sm text-muted-foreground">
              {t("decoServe.guide.step2.body")}
            </p>
            {needsGesture ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">
                  {t("decoServe.guide.step2.askFirst")}
                </p>
                <Button variant="outline" onClick={discovery.start}>
                  <SearchSm />
                  {t("decoServe.guide.step2.start")}
                </Button>
              </div>
            ) : (
              access !== "denied" &&
              candidates.length > 0 && (
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

          <Step index={3} title={t("decoServe.guide.step3.title")}>
            <p className="text-sm text-muted-foreground">
              <RichCode text={t("decoServe.guide.step3.body")} />
            </p>
            <ManualConnect onConnect={onConnect} />
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

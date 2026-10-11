/**
 * The ONE empty state of the site editor while it waits for `deco serve` on
 * this computer: `/site-editor` before its editor opens, and a project's
 * Preview with Localhost chosen. Both render `LocalServeEmptyState`, with
 * the same copy, steps, links and animation; only where things stand
 * (`LocalServeWait`) changes what it shows, the same way in both places.
 */

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import { SERVE_COMMAND, type ServeProblem } from "./deco-serve-connection";
import {
  DocsLinks,
  LocalNetworkDeniedAlert,
  RichCode,
  serveProblemCopy,
} from "./deco-serve-notices";
import type { LocalhostStatus } from "./localhost-status";
import { ServeConnectState } from "./serve-connect-state";

/** Where the wait for `deco serve` stands. */
export type LocalServeWait =
  /** Looking for it, on its own; `paused` while the tab is hidden. */
  | { kind: "looking"; paused?: boolean }
  /**
   * Chrome will ask for permission to reach this computer, and only asks
   * after a click: the button is that click. (A project's Localhost never
   * needs it: choosing Localhost was the click.)
   */
  | { kind: "needs-gesture"; onStart: () => void }
  /** Chrome blocks Studio from reaching this computer. */
  | { kind: "denied" }
  /** Something answered but can't be used; it keeps checking on its own. */
  | { kind: "problem"; problem: ServeProblem; host: string };

export function LocalServeEmptyState({
  wait,
  hosts,
  invalidLink = false,
}: {
  wait: LocalServeWait;
  /** Where it looks, for the status line (`localhost:4545`). */
  hosts: string;
  /** `/site-editor` was opened with a link that isn't a usable one. */
  invalidLink?: boolean;
}) {
  const t = useT();
  const linkAlert = invalidLink && (
    <Alert variant="warning">
      <div className="flex min-w-0 flex-col gap-1">
        <AlertTitle className="line-clamp-none text-foreground">
          {t("decoServe.link.invalidTitle")}
        </AlertTitle>
        <AlertDescription>{t("decoServe.link.invalidBody")}</AlertDescription>
      </div>
    </Alert>
  );

  if (wait.kind === "problem") {
    const { title, body } = serveProblemCopy(t, wait.problem, wait.host);
    return (
      <ServeConnectState
        headingLevel={2}
        waiting={false}
        title={title}
        lead={<RichCode text={body} />}
        alerts={linkAlert}
        footer={
          <DocsLinks
            className="border-t border-border pt-4"
            links={["troubleshooting", "serve"]}
          />
        }
      />
    );
  }

  const looking = wait.kind === "looking";
  return (
    <ServeConnectState
      headingLevel={2}
      waiting={looking && !wait.paused}
      title={t("decoServe.waiting.title")}
      lead={t("decoServe.waiting.lead")}
      alerts={
        (linkAlert || wait.kind === "denied") && (
          <>
            {linkAlert}
            {wait.kind === "denied" && <LocalNetworkDeniedAlert />}
          </>
        )
      }
      steps={[
        {
          title: t("decoServe.guide.step1.title"),
          body: <RichCode text={t("decoServe.guide.step1.body")} />,
          command: SERVE_COMMAND,
        },
        {
          title: t("decoServe.waiting.step2.title"),
          body: t("decoServe.waiting.step2.body"),
          after:
            wait.kind === "needs-gesture" ? (
              <Button
                variant="outline"
                className="self-start"
                onClick={wait.onStart}
              >
                {t("decoServe.guide.step2.start")}
              </Button>
            ) : (
              looking && (
                <p role="status" className="text-sm text-muted-foreground">
                  {wait.paused
                    ? t("decoServe.guide.step2.paused")
                    : t("decoServe.guide.step2.looking", { hosts })}
                </p>
              )
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

/** A project's chosen Localhost, before `deco serve` answers. */
export function localhostWait(
  status: Exclude<LocalhostStatus, { kind: "connected" }>,
  host: string,
): LocalServeWait {
  switch (status.kind) {
    case "needs-permission":
      return { kind: "denied" };
    case "problem":
      return { kind: "problem", problem: status.problem, host };
    default:
      return { kind: "looking" };
  }
}

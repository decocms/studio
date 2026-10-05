/**
 * The pieces the site editor explains a `deco serve` connection with: the
 * command to copy, docs links, and one message per connection problem (what
 * happened, why, and the one thing to do next). Shared by `/site-editor`'s
 * guide, its connection gate, the "Local server" chip and the draft
 * selector's Local tab.
 */

import { Fragment, type ReactNode } from "react";
import { Check, Copy01, LinkExternal01 } from "@untitledui/icons";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";
import { useT } from "@/i18n/use-t.ts";
import { blocksDocs } from "@/lib/blocks-docs";
import type { ServeProblem } from "./deco-serve-connection";

/** A translated sentence whose `backticked` parts render as code. */
export function RichCode({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code
            // oxlint-disable-next-line no-array-index-key -- static split of one sentence
            key={index}
            className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground"
          >
            {part}
          </code>
        ) : (
          // oxlint-disable-next-line no-array-index-key -- static split of one sentence
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** A terminal command with a Copy button that says when it copied. */
export function CommandSnippet({ command }: { command: string }) {
  const t = useT();
  const { handleCopy, copied } = useCopy();
  return (
    <div className="flex items-stretch gap-2">
      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-xs leading-5 text-foreground">
        <code>
          <span
            aria-hidden="true"
            className="select-none text-muted-foreground"
          >
            ${" "}
          </span>
          {command}
        </code>
      </pre>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-auto shrink-0"
        aria-label={t("decoServe.guide.copy")}
        onClick={() => void handleCopy(command).catch(() => {})}
      >
        {copied ? <Check /> : <Copy01 />}
        <span>
          {copied ? t("decoServe.guide.copied") : t("decoServe.guide.copy")}
        </span>
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? t("decoServe.guide.copiedAnnouncement") : ""}
      </span>
    </div>
  );
}

type DocsLink = keyof typeof blocksDocs;

const DOCS_LABELS: Record<DocsLink, TranslationKey> = {
  quickstart: "decoServe.docs.quickstart",
  siteEditor: "decoServe.docs.siteEditor",
  serve: "decoServe.docs.serve",
  schema: "decoServe.docs.schema",
  troubleshooting: "decoServe.docs.troubleshooting",
};

/** A row of links into the Blocks docs, each opening in a new tab. */
export function DocsLinks({
  links,
  className,
}: {
  links: readonly DocsLink[];
  className?: string;
}) {
  const t = useT();
  return (
    <nav
      aria-label={t("decoServe.docs.heading")}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-sm",
        className,
      )}
    >
      <span className="text-muted-foreground">
        {t("decoServe.docs.heading")}
      </span>
      {links.map((link) => (
        <a
          key={link}
          href={blocksDocs[link]}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline focus-visible:underline"
        >
          {t(DOCS_LABELS[link])}
          <LinkExternal01 aria-hidden="true" className="size-3.5" />
          <span className="sr-only">{t("decoServe.docs.newTab")}</span>
        </a>
      ))}
    </nav>
  );
}

/** Title and explanation of a server that answered but can't be used. */
export function serveProblemCopy(
  t: TFunction,
  problem: ServeProblem,
  host: string,
): { title: string; body: string } {
  switch (problem.reason) {
    case "not-answering":
      return {
        title: t("decoServe.state.notAnswering.title"),
        body: t("decoServe.state.notAnswering.body", { host }),
      };
    case "outdated":
      return {
        title: t("decoServe.state.outdated.title"),
        body: t("decoServe.state.outdated.body", { host }),
      };
    case "version-mismatch":
      return {
        title: t("decoServe.state.versionMismatch.title"),
        body: t("decoServe.state.versionMismatch.body", { host }),
      };
    case "not-deco-serve":
      return {
        title: t("decoServe.state.notDecoServe.title", { host }),
        body: t("decoServe.state.notDecoServe.body", { host }),
      };
    case "error":
      return {
        title: t("decoServe.state.error.title"),
        body: t("decoServe.state.error.body", {
          detail: problem.detail ?? "",
        }),
      };
  }
}

/** One line for tight spots (the chip's tooltip, the Local tab). */
export function serveProblemShort(
  t: TFunction,
  problem: ServeProblem,
  host: string,
): string {
  if (problem.reason === "not-answering") {
    return t("decoServe.state.notAnswering.short", { host });
  }
  const { title, body } = serveProblemCopy(t, problem, host);
  return `${title}. ${body}`;
}

/** A problem as an Alert, with an optional action under it. */
export function ServeProblemAlert({
  problem,
  host,
  children,
}: {
  problem: ServeProblem;
  host: string;
  children?: ReactNode;
}) {
  const t = useT();
  const { title, body } = serveProblemCopy(t, problem, host);
  return (
    <Alert variant="warning">
      <div className="flex min-w-0 flex-col gap-1">
        <AlertTitle className="line-clamp-none text-foreground">
          {title}
        </AlertTitle>
        <AlertDescription>
          <RichCode text={body} />
        </AlertDescription>
        {children}
      </div>
    </Alert>
  );
}

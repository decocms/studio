/**
 * One hypothesis on why a loss happens, on the loss's page: the idea and why,
 * what the verification saw, the A/B the engine designed, the evidence behind
 * it, and the member's decision. Approval follows the engine's rule: only a
 * hypothesis ready to test can be approved.
 */

import { type ReactNode, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  LinkExternal01,
  FlipBackward,
  ThumbsDown,
  ThumbsUp,
} from "@untitledui/icons";
import { Badge, BadgeDot } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import type { OpportunityHypothesis } from "./diagnosis-schema.ts";
import { DEVICE_LABEL, VERDICT_LABEL } from "./labels.ts";
import {
  errorText,
  formatCount,
  formatPercent,
  hypothesisActions,
  hypothesisLine,
  safeHref,
} from "./opportunity-view.ts";
import {
  type DecideHypothesisInput,
  useDecideHypothesis,
} from "./use-plan-diagnosis.ts";

type Experiment = NonNullable<OpportunityHypothesis["experiment"]>;
type CheckRun = NonNullable<
  OpportunityHypothesis["verification"]
>["runs"][number];
type Citation = OpportunityHypothesis["citations"][number];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

function SignedImage({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("plan.opportunities.detail.hypothesis.imageExpired")}
      </p>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="max-h-96 w-full rounded-lg border border-border object-contain object-top"
    />
  );
}

/** The engine's images are signed for an hour. A refetch signs them again,
 *  so a new URL gets a fresh try instead of the expired one's state. */
function EngineImage({ src, alt }: { src: string | null; alt: string }) {
  const href = safeHref(src);
  if (!href) return null;
  return <SignedImage key={href} src={href} alt={alt} />;
}

function ExperimentBlock({ experiment: e }: { experiment: Experiment }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const number = (value: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
  const metricValues = {
    label: e.metrica_primaria.label,
    device: t(DEVICE_LABEL[e.metrica_primaria.device]).toLowerCase(),
    baseline: formatPercent(e.baseline, language, 2),
    mde: number(e.mde_pp),
  };
  const rows: Array<[string, string]> = [
    [t("plan.opportunities.detail.experiment.control"), e.controle],
    [t("plan.opportunities.detail.experiment.variant"), e.variante],
    [
      t("plan.opportunities.detail.experiment.metric"),
      e.direction === "sobe"
        ? t("plan.opportunities.detail.experiment.metricUp", metricValues)
        : t("plan.opportunities.detail.experiment.metricDown", metricValues),
    ],
    [
      t("plan.opportunities.detail.experiment.guardrails"),
      e.guardrails.join("; "),
    ],
    [
      t("plan.opportunities.detail.experiment.sample"),
      e.n_per_group > 0
        ? t("plan.opportunities.detail.experiment.sampleValue", {
            perGroup: formatCount(e.n_per_group, language),
            eligible: formatCount(e.weekly_eligible, language),
          })
        : "",
    ],
    [
      t("plan.opportunities.detail.experiment.duration"),
      e.weeks === 1
        ? t("plan.opportunities.detail.experiment.weeks.one")
        : t("plan.opportunities.detail.experiment.weeks.other", {
            count: e.weeks,
          }),
    ],
  ];
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("plan.opportunities.detail.experiment.heading")}
        </h4>
        {!e.measurable && (
          <Badge variant="warning">
            {t("plan.opportunities.detail.experiment.notMeasurable")}
          </Badge>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-foreground">{value}</dd>
            </div>
          ))}
      </dl>
      {e.mde_4_weeks_pp !== null && !e.measurable && (
        <p className="text-xs text-muted-foreground">
          {t("plan.opportunities.detail.experiment.mde4Weeks", {
            mde: number(e.mde_4_weeks_pp),
          })}
        </p>
      )}
      {e.limitacoes.length > 0 && (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-muted-foreground">
          {e.limitacoes.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CheckRuns({ runs }: { runs: CheckRun[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {runs.map((run) => (
        <li key={run.check.id} className="flex flex-col gap-1.5 text-sm">
          <span className="text-foreground">{run.check.claim}</span>
          <span className="text-xs text-muted-foreground">{run.observed}</span>
          <EngineImage src={run.screenshot_url} alt={run.check.claim} />
        </li>
      ))}
    </ul>
  );
}

function Citations({ citations }: { citations: Citation[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {citations.map((c) => {
        const href = safeHref(c.fonte_url);
        return (
          <li key={c.id} className="flex flex-col gap-1 text-sm">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 self-start text-foreground underline-offset-4 hover:underline"
              >
                {c.fonte}
                <LinkExternal01 className="size-3.5 shrink-0" />
              </a>
            ) : (
              <span className="text-foreground">{c.fonte}</span>
            )}
            {c.trecho && (
              <blockquote className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
                {c.trecho}
              </blockquote>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Evidence({ hypothesis: h }: { hypothesis: OpportunityHypothesis }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const runs = h.verification?.runs ?? [];
  if (runs.length === 0 && h.citations.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground focus-ring">
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
        {t("plan.opportunities.detail.evidence.toggle")}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-5 pt-4">
        {runs.length > 0 && (
          <Block title={t("plan.opportunities.detail.evidence.checks")}>
            <CheckRuns runs={runs} />
          </Block>
        )}
        {h.citations.length > 0 && (
          <Block title={t("plan.opportunities.detail.evidence.citations")}>
            <Citations citations={h.citations} />
          </Block>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Decision({ hypothesis: h }: { hypothesis: OpportunityHypothesis }) {
  const t = useT();
  const decide = useDecideHypothesis();
  const actions = hypothesisActions(h);
  const set = (status: DecideHypothesisInput["status"]) =>
    decide.mutate({ hypothesis_id: h.id, status });
  const busy = decide.isPending;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      {decide.isError && (
        <div
          className="flex items-start gap-2 text-xs text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>{t("plan.opportunities.detail.actions.failed")}</span>
            {errorText(decide.error) && (
              <span className="break-words text-muted-foreground">
                {errorText(decide.error)}
              </span>
            )}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {actions.undo ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => set("pending")}
          >
            <FlipBackward />
            {t("plan.opportunities.detail.actions.undo")}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !actions.dismiss}
              onClick={() => set("dismissed")}
            >
              <ThumbsDown />
              {t("plan.opportunities.detail.actions.dismiss")}
            </Button>
            {!actions.approve && (
              <span className="text-xs text-muted-foreground">
                {t("plan.opportunities.detail.actions.approveBlocked")}
              </span>
            )}
            <Button
              size="sm"
              disabled={busy || !actions.approve}
              onClick={() => set("approved")}
            >
              <ThumbsUp />
              {t("plan.opportunities.detail.actions.approve")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function HypothesisCard({
  hypothesis: h,
  number,
  onCreateCase,
}: {
  hypothesis: OpportunityHypothesis;
  /** Its place on the page, from 1. */
  number: number;
  /** Shown on the loss's ready hypothesis; hidden when absent. */
  onCreateCase?: () => void;
}) {
  const t = useT();
  const line = hypothesisLine(h);
  const { decision } = hypothesisActions(h);
  return (
    <Card
      className={cn(
        "gap-4",
        decision === "dismissed" && "opacity-70",
        decision === "approved" && "ring-1 ring-success/40",
      )}
    >
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="default">
          {t("plan.opportunities.detail.hypothesis.label", { number })}
        </Badge>
        <Badge variant={line.verdict === "confirmed" ? "success" : "muted"}>
          {t(VERDICT_LABEL[line.verdict])}
        </Badge>
        {decision === "approved" && (
          <Badge variant="success">
            <BadgeDot />
            {t("plan.opportunities.detail.hypothesis.approved")}
          </Badge>
        )}
        {decision === "dismissed" && (
          <Badge variant="muted">
            {t("plan.opportunities.detail.hypothesis.dismissed")}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3
          className={cn(
            "text-base font-medium text-foreground",
            line.strike && "text-muted-foreground line-through",
          )}
        >
          {h.title}
        </h3>
        {h.why && <p className="text-sm text-muted-foreground">{h.why}</p>}
      </div>

      {h.verification?.summary && (
        <Block title={t("plan.opportunities.detail.hypothesis.verification")}>
          <p className="text-sm text-foreground">{h.verification.summary}</p>
          {h.verification.rewritten_from && (
            <p className="text-xs text-muted-foreground">
              {t("plan.opportunities.detail.hypothesis.rewrittenFrom", {
                title: h.verification.rewritten_from.title,
              })}
            </p>
          )}
        </Block>
      )}

      {h.idea ? (
        <Block title={t("plan.opportunities.detail.hypothesis.idea")}>
          <p className="text-sm text-foreground">{h.idea}</p>
          {h.where && (
            <p className="text-xs text-muted-foreground">
              {t("plan.opportunities.detail.hypothesis.where", {
                where: h.where,
              })}
            </p>
          )}
          <div className="grid gap-3 pt-1 sm:grid-cols-2">
            <EngineImage
              src={h.before_url}
              alt={t("plan.opportunities.detail.hypothesis.before")}
            />
            <EngineImage
              src={h.after_url}
              alt={t("plan.opportunities.detail.hypothesis.after")}
            />
          </div>
        </Block>
      ) : (
        <p className="rounded-lg bg-muted px-4 py-3 text-xs text-muted-foreground">
          {t("plan.opportunities.detail.hypothesis.noChange")}
        </p>
      )}

      {h.experiment && <ExperimentBlock experiment={h.experiment} />}

      <Evidence hypothesis={h} />

      {onCreateCase && (
        <Button className="self-start" onClick={onCreateCase}>
          {t("plan.opportunities.card.createCase")}
          <ArrowRight />
        </Button>
      )}

      <Decision hypothesis={h} />
    </Card>
  );
}

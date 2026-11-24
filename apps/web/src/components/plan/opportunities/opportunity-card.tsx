/**
 * One of the two biggest losses on Plan: what it is worth a month, the loss
 * the engine measured, how far the investigation got, and the next step —
 * a business case once a hypothesis is ready, the hypotheses otherwise.
 */

import { useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  Monitor01,
  Phone01,
  Trophy01,
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
import { type TFunction, useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import type {
  StoreOpportunity,
  StoreOpportunityHypothesis,
} from "./diagnosis-schema.ts";
import { CreateCaseButton } from "./create-case-button.tsx";
import { DEVICE_LABEL, PAGE_LABEL, VERDICT_LABEL } from "./labels.ts";
import {
  cardState,
  dataBadge,
  formatMoney,
  hypothesesTally,
  hypothesisLine,
  readyHypothesis,
} from "./opportunity-view.ts";
import type { CaseCreation } from "./use-create-case.ts";

export interface OpportunityActions {
  /** Starts a business case from a ready hypothesis. Hidden when absent. */
  onCreateCase?: (
    opportunity: StoreOpportunity,
    hypothesis: StoreOpportunityHypothesis,
  ) => void;
  /** Where each loss's case start stands. */
  caseCreation?: (opportunityId: string) => CaseCreation;
  /** Opens the loss's detail. Hidden when absent. */
  onOpenOpportunity?: (opportunityId: string) => void;
}

export function tallyText(t: TFunction, o: StoreOpportunity): string {
  const { total, ready, confirmed } = hypothesesTally(o);
  if (total === 0) return t("plan.opportunities.card.hypotheses.none");
  const count =
    total === 1
      ? t("plan.opportunities.card.hypotheses.one")
      : t("plan.opportunities.card.hypotheses.other", { count: total });
  const progress =
    ready > 0
      ? ready === 1
        ? t("plan.opportunities.card.tally.readyOne")
        : t("plan.opportunities.card.tally.readyOther", { count: ready })
      : confirmed > 0
        ? confirmed === 1
          ? t("plan.opportunities.card.tally.confirmedOne")
          : t("plan.opportunities.card.tally.confirmedOther", {
              count: confirmed,
            })
        : t("plan.opportunities.card.tally.none");
  return `${count} · ${progress}`;
}

/** How far the investigation got, and how much to trust the data. */
export function LossBadges({ opportunity }: { opportunity: StoreOpportunity }) {
  const t = useT();
  const badge = dataBadge(opportunity);
  return (
    <>
      {cardState(opportunity) === "ready" ? (
        <Badge variant="lime">
          <BadgeDot />
          {t("plan.opportunities.card.ready")}
        </Badge>
      ) : (
        <Badge variant="warning">
          <BadgeDot />
          {t("plan.opportunities.card.investigating")}
        </Badge>
      )}
      {badge === "reliable" && (
        <Badge variant="success">
          <BadgeDot />
          {t("plan.opportunities.card.reliable")}
        </Badge>
      )}
      {badge === "low_sample" && (
        <Badge variant="warning">
          <BadgeDot />
          {t("plan.opportunities.card.lowSample")}
        </Badge>
      )}
    </>
  );
}

function BasedOn({
  opportunity,
  ready,
}: {
  opportunity: StoreOpportunity;
  ready: StoreOpportunityHypothesis | null;
}) {
  const t = useT();
  const [first, ...rest] = opportunity.sources;
  if (ready) {
    return (
      <div className="flex flex-col gap-1 rounded-lg bg-muted px-4 py-3 text-sm">
        <span className="text-xs text-muted-foreground">
          {t("plan.opportunities.card.causeConfirmed")}
        </span>
        <span className="text-foreground">
          {ready.verification?.summary || ready.title}
        </span>
      </div>
    );
  }
  if (!first) return null;
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted px-4 py-3 text-sm">
      <span className="text-xs text-muted-foreground">
        {t("plan.opportunities.card.basedOn")}
      </span>
      <span className="text-foreground">
        <span className="font-medium">{first.source}</span>
        {` · ${first.metric}: ${first.value}`}
        {first.window && (
          <span className="text-muted-foreground">{` (${first.window})`}</span>
        )}
        {rest.length > 0 && (
          <span className="text-muted-foreground">{` +${rest.length}`}</span>
        )}
      </span>
    </div>
  );
}

function Hypotheses({
  opportunity,
  defaultOpen,
}: {
  opportunity: StoreOpportunity;
  defaultOpen: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  if (opportunity.hypotheses.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {tallyText(t, opportunity)}
      </p>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-md text-left text-sm text-muted-foreground hover:text-foreground focus-ring">
        {tallyText(t, opportunity)}
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="flex flex-col gap-3 pt-3">
          {opportunity.hypotheses.map((h, i) => {
            const line = hypothesisLine(h);
            return (
              <li key={h.id} className="flex gap-3 text-sm">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className={cn(
                      "text-foreground",
                      line.strike && "text-muted-foreground line-through",
                    )}
                  >
                    {line.text}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(VERDICT_LABEL[line.verdict])}
                    {h.verification?.summary
                      ? `: ${h.verification.summary}`
                      : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function OpportunityCard({
  opportunity,
  position,
  onCreateCase,
  caseCreation,
  onOpenOpportunity,
}: OpportunityActions & {
  opportunity: StoreOpportunity;
  /** 0 for the biggest loss. */
  position: number;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const state = cardState(opportunity);
  const ready = readyHypothesis(opportunity);
  const { money } = opportunity;
  const biggest = position === 0;
  const DeviceIcon = opportunity.device === "desktop" ? Monitor01 : Phone01;

  const opened = (action: "create_case" | "see_hypotheses") =>
    track("plan_opportunity_opened", { state, position, action });

  return (
    <Card className={cn("gap-4", biggest && "ring-1 ring-brand")}>
      <div className="flex flex-wrap gap-1.5">
        {biggest ? (
          <Badge variant="lime">
            <Trophy01 />
            {t("plan.opportunities.card.biggest")}
          </Badge>
        ) : (
          <Badge variant="muted">{t("plan.opportunities.card.second")}</Badge>
        )}
        <Badge variant="muted">{t(PAGE_LABEL[opportunity.page_type])}</Badge>
        <Badge variant="muted">
          <DeviceIcon />
          {t(DEVICE_LABEL[opportunity.device])}
        </Badge>
      </div>

      {money ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-3xl font-medium text-foreground">
            {formatMoney(money.monthly_value, language)}
            <span className="text-sm font-normal text-muted-foreground">
              {t("plan.opportunities.card.perMonth")}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {t("plan.opportunities.card.atStake", {
              delta: new Intl.NumberFormat(language, {
                maximumFractionDigits: 1,
              }).format(money.delta_pp),
            })}
            {money.ceiling_monthly !== null &&
              ` · ${t("plan.opportunities.card.ceiling", {
                value: formatMoney(money.ceiling_monthly, language),
              })}`}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("plan.opportunities.card.noMoney")}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">
          {onOpenOpportunity ? (
            // Ready cards' CTA is the business case, so the title is their way in.
            <button
              type="button"
              className="rounded-sm text-left underline-offset-4 hover:underline focus-ring"
              onClick={() => {
                opened("see_hypotheses");
                onOpenOpportunity(opportunity.id);
              }}
            >
              {opportunity.title}
            </button>
          ) : (
            opportunity.title
          )}
        </h3>
        <p className="text-sm text-muted-foreground">{opportunity.summary}</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <LossBadges opportunity={opportunity} />
      </div>

      <BasedOn opportunity={opportunity} ready={ready} />

      <Hypotheses
        opportunity={opportunity}
        defaultOpen={state === "investigating"}
      />

      {state === "ready" && ready && onCreateCase && (
        <CreateCaseButton
          className="mt-auto"
          variant={biggest ? "default" : "outline"}
          creation={caseCreation?.(opportunity.id)}
          onClick={() => {
            opened("create_case");
            onCreateCase(opportunity, ready);
          }}
        />
      )}
      {state === "investigating" && onOpenOpportunity && (
        <Button
          className="mt-auto"
          variant={biggest ? "default" : "outline"}
          onClick={() => {
            opened("see_hypotheses");
            onOpenOpportunity(opportunity.id);
          }}
        >
          {t("plan.opportunities.card.seeHypotheses")}
          <ArrowRight />
        </Button>
      )}
    </Card>
  );
}

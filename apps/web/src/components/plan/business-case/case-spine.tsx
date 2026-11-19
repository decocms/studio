/**
 * The story under the verdict: four acts on one rail (why, what, is it worth
 * it, how we prove it) and what is still open. Each step shows one line and at
 * most one picture; bullets, sources and assumptions wait behind "details".
 */

import { useState, type ReactNode } from "react";
import type {
  BusinessCase,
  BusinessCaseCard,
  BusinessCaseCardKey,
  BusinessCaseMetric,
} from "@decocms/shared/business-case";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ChevronDown, MessageChatCircle } from "@untitledui/icons";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { useCaseFormat } from "./case-format.ts";
import type { ActKey, CaseStory, DotState } from "./case-story.ts";

const CARD: Record<
  BusinessCaseCardKey,
  { title: TranslationKey; question: TranslationKey }
> = {
  problem: {
    title: "plan.case.card.problem",
    question: "plan.case.card.problemQuestion",
  },
  scope: {
    title: "plan.case.card.scope",
    question: "plan.case.card.scopeQuestion",
  },
  money: {
    title: "plan.case.card.money",
    question: "plan.case.card.moneyQuestion",
  },
  competitors: {
    title: "plan.case.card.competitors",
    question: "plan.case.card.competitorsQuestion",
  },
  measurement: {
    title: "plan.case.card.measurement",
    question: "plan.case.card.measurementQuestion",
  },
  abTest: {
    title: "plan.case.card.abTest",
    question: "plan.case.card.abTestQuestion",
  },
  effort: {
    title: "plan.case.card.effort",
    question: "plan.case.card.effortQuestion",
  },
  risks: {
    title: "plan.case.card.risks",
    question: "plan.case.card.risksQuestion",
  },
  unknowns: {
    title: "plan.case.card.unknowns",
    question: "plan.case.card.unknownsQuestion",
  },
};

const ACT_LABEL: Record<ActKey | "open", TranslationKey> = {
  why: "plan.case.act.why",
  what: "plan.case.act.what",
  worth: "plan.case.act.worth",
  prove: "plan.case.act.prove",
  open: "plan.case.act.open",
};

function Dot({ state }: { state: DotState }) {
  return (
    <span className="relative mt-1 flex size-3.5 items-center justify-center">
      {state === "asking" && (
        <span className="absolute inset-0 rounded-full bg-special/40 motion-safe:animate-ping" />
      )}
      <span
        className={cn(
          "relative size-3.5 rounded-full border-[3px] border-card transition-colors duration-500",
          state === "done" && "bg-foreground ring-1 ring-foreground",
          state === "asking" && "bg-special ring-1 ring-special",
          state === "open" && "bg-card ring-1 ring-muted-foreground/40",
        )}
      />
    </span>
  );
}

function Act({
  label,
  number,
  dot,
  first,
  last,
  children,
}: {
  label: string;
  number: string;
  dot: DotState;
  first?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  const muted = dot === "open";
  const heading = (
    <>
      <div className="text-[11px] font-medium text-muted-foreground/70 tabular-nums">
        {number}
      </div>
      <div
        className={cn(
          "text-sm font-semibold",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {label}
      </div>
    </>
  );
  return (
    <div className="grid grid-cols-[1.75rem_1fr] gap-x-3 @2xl:grid-cols-[7rem_1.75rem_1fr] @2xl:gap-x-4">
      <div className="hidden pt-0.5 text-right @2xl:block">{heading}</div>
      <div
        className={cn(
          "relative flex justify-center",
          "before:absolute before:w-0.5 before:bg-border",
          first ? "before:top-3" : "before:top-0",
          last ? "before:h-3" : "before:bottom-0",
        )}
      >
        <Dot state={dot} />
      </div>
      <div className={cn("flex min-w-0 flex-col", !last && "pb-10")}>
        <div className="mb-2 flex items-baseline gap-2 @2xl:hidden">
          {heading}
        </div>
        {children}
      </div>
    </div>
  );
}

function Details({ card }: { card: BusinessCaseCard }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!card.bullets.length && !card.sources.length && !card.assumption) {
    return null;
  }
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-ring"
      >
        {t(open ? "plan.case.hideDetails" : "plan.case.showDetails")}
        <ChevronDown
          size={12}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-muted/60 px-3.5 py-3 text-[13px] text-muted-foreground">
          {card.bullets.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {card.bullets.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          )}
          {card.assumption && (
            <p>
              <span className="font-medium text-foreground">
                {t("plan.case.assumption")}
              </span>{" "}
              {card.assumption}
            </p>
          )}
          {card.sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {card.sources.map((source, i) =>
                source.url ? (
                  <a
                    key={i}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="max-w-full truncate rounded-full border bg-card px-2 py-0.5 text-[11px] hover:text-foreground"
                  >
                    {source.label}
                  </a>
                ) : (
                  <span
                    key={i}
                    className="max-w-full truncate rounded-full border bg-card px-2 py-0.5 text-[11px]"
                  >
                    {source.label}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One card on the rail: its question while empty, the live question while
 *  the chat asks it, its line and picture once filled. */
function Step({
  cardKey,
  card,
  label,
  children,
  divider,
}: {
  cardKey: BusinessCaseCardKey;
  card: BusinessCaseCard;
  label?: string;
  children?: ReactNode;
  divider?: boolean;
}) {
  const t = useT();
  const title = label ?? t(CARD[cardKey].title);
  const frame = cn(divider && "mt-4 border-t border-dashed pt-4");

  if (card.state === "asking") {
    return (
      <div className={frame}>
        <div
          aria-busy
          className="rounded-xl border border-special/30 bg-special/5 px-4 py-3"
        >
          <div className="flex items-center gap-1.5 text-xs text-special">
            <span className="size-1.5 rounded-full bg-special motion-safe:animate-pulse" />
            {t("plan.case.asking")} · {title}
          </div>
          <p className="mt-1 text-[15px] text-pretty text-foreground">
            {card.question ?? t(CARD[cardKey].question)}
          </p>
        </div>
      </div>
    );
  }

  if (card.state === "empty") {
    return (
      <div className={frame}>
        <div className="text-xs text-muted-foreground/70">{title}</div>
        <p className="mt-0.5 text-[15px] text-pretty text-muted-foreground/70">
          {t(CARD[cardKey].question)}
        </p>
      </div>
    );
  }

  return (
    <div className={frame}>
      <div className="text-xs text-muted-foreground">{title}</div>
      {card.summary && (
        <p className="mt-0.5 text-[17px] leading-snug text-pretty text-foreground">
          {card.summary}
        </p>
      )}
      {children}
      <Details card={card} />
    </div>
  );
}

function Comparison({ card }: { card: BusinessCaseCard }) {
  const format = useCaseFormat();
  const [first, ...rest] = card.metrics ?? [];
  if (!first) return null;
  const bars = [first, ...rest.filter((m) => m.unit === first.unit)];
  const others = rest.filter((m) => m.unit !== first.unit);
  const max =
    first.unit === "percent" ? 100 : Math.max(...bars.map((m) => m.value));
  return (
    <>
      <div className="mt-3 flex max-w-md flex-col gap-2">
        {bars.map((metric, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-xs text-muted-foreground"
          >
            <span className="truncate">{metric.label}</span>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-700",
                  i === 0 ? "bg-foreground" : "bg-muted-foreground/40",
                )}
                style={{
                  width: `${max > 0 ? Math.max(2, Math.min(100, (metric.value / max) * 100)) : 0}%`,
                }}
              />
            </div>
            <span className="font-semibold text-foreground tabular-nums">
              {format.metric(metric)}
            </span>
          </div>
        ))}
      </div>
      <MetricChips metrics={others} />
    </>
  );
}

function Competitors({ card }: { card: BusinessCaseCard }) {
  if (!card.sources.length) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {card.sources.map((source, i) => {
        const chip = (
          <>
            <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
              {source.label.trim().charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{source.label}</span>
          </>
        );
        const className =
          "flex max-w-full items-center gap-1.5 rounded-full border bg-card py-0.5 pr-2.5 pl-1 text-xs text-muted-foreground";
        return source.url ? (
          <a
            key={i}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className={cn(className, "hover:text-foreground")}
          >
            {chip}
          </a>
        ) : (
          <span key={i} className={className}>
            {chip}
          </span>
        );
      })}
    </div>
  );
}

function MoneyChain({ card }: { card: BusinessCaseCard }) {
  const t = useT();
  const format = useCaseFormat();
  if (card.calc?.kind !== "money") return null;
  const calc = card.calc;
  const links: { value: string; label: string; result?: boolean }[] = [
    {
      value: format.compact(calc.base),
      label: calc.baseLabel ?? t("plan.case.chain.base"),
    },
    {
      value: `+${format.number(calc.deltaPp)} p.p.`,
      label: t("plan.case.chain.delta"),
    },
    {
      value: format.money(calc.value),
      label: calc.valueLabel ?? t("plan.case.chain.value"),
    },
    {
      value: format.money(calc.monthlyValue),
      label: t("plan.case.chain.result"),
      result: true,
    },
  ];
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-stretch gap-1.5">
        {links.map((link, i) => (
          <div key={i} className="flex items-stretch gap-1.5">
            {i > 0 && (
              <span className="self-center text-sm text-muted-foreground/60">
                {i === links.length - 1 ? "=" : "×"}
              </span>
            )}
            <div
              className={cn(
                "min-w-24 rounded-xl border px-3 py-2",
                link.result && "border-success/25 bg-success/5",
              )}
            >
              <div
                className={cn(
                  "text-[17px] font-semibold tracking-tight tabular-nums",
                  link.result ? "text-success" : "text-foreground",
                )}
              >
                {link.value}
              </div>
              <div className="text-[11.5px] text-muted-foreground">
                {link.label}
              </div>
            </div>
          </div>
        ))}
      </div>
      {calc.ceilingMonthly !== null && (
        <p className="text-xs text-muted-foreground">
          {t("plan.case.chain.ceiling", {
            ceiling: format.money(calc.ceilingMonthly),
          })}
        </p>
      )}
    </div>
  );
}

function MetricChips({ metrics }: { metrics: BusinessCaseMetric[] }) {
  const format = useCaseFormat();
  if (!metrics.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {metrics.map((metric, i) => (
        <span
          key={i}
          className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
        >
          {metric.label}{" "}
          <span className="font-medium text-foreground tabular-nums">
            {format.metric(metric)}
          </span>
        </span>
      ))}
    </div>
  );
}

function AbTestStrip({ card }: { card: BusinessCaseCard }) {
  const t = useT();
  const format = useCaseFormat();
  if (card.calc?.kind !== "abTest") return null;
  const { weeks, nPerGroup, measurable } = card.calc;
  return (
    <div className="mt-3 grid gap-1.5 text-xs @xl:grid-cols-[1fr_1fr_auto]">
      <span className="rounded-lg bg-muted px-3 py-2">
        <b className="font-semibold">A</b> · {t("plan.case.ab.control")}
      </span>
      <span className="rounded-lg bg-success/10 px-3 py-2">
        <b className="font-semibold">B</b> · {t("plan.case.ab.variant")}
      </span>
      <span
        className={cn(
          "rounded-lg px-3 py-2",
          measurable ? "bg-muted" : "bg-warning/10 text-warning",
        )}
      >
        {measurable && weeks !== null
          ? [
              t(weeks === 1 ? "plan.case.weeks.one" : "plan.case.weeks.other", {
                count: weeks,
              }),
              nPerGroup !== null &&
                t("plan.case.tile.perGroup", {
                  count: format.compact(nPerGroup),
                }),
            ]
              .filter(Boolean)
              .join(" · ")
          : t("plan.case.tile.unmeasurable")}
      </span>
    </div>
  );
}

function Risk({ card }: { card: BusinessCaseCard }) {
  const t = useT();
  if (card.state !== "filled") {
    return <Step cardKey="risks" card={card} divider />;
  }
  return (
    <div className="mt-4">
      <div className="rounded-r-lg border-l-[3px] border-warning bg-warning/5 px-3.5 py-2.5 text-[13px] text-muted-foreground">
        <span className="font-semibold text-warning">
          {t("plan.case.card.risks")}
        </span>
        {card.summary && <> · {card.summary}</>}
      </div>
      <Details card={card} />
    </div>
  );
}

function OpenQuestions({
  questions,
  onAsk,
}: {
  questions: string[];
  onAsk?: (question: string) => void;
}) {
  const t = useT();
  return (
    <ul className="flex flex-col">
      {questions.map((question, i) => (
        <li
          key={i}
          className={cn(
            "flex items-start gap-3 py-2 text-sm text-foreground",
            i > 0 && "border-t border-dashed",
          )}
        >
          <span className="min-w-0 flex-1 text-pretty">{question}</span>
          {onAsk && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => onAsk(question)}
            >
              <MessageChatCircle />
              {t("plan.case.askInChat")}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function CaseSpine({
  value,
  story,
  onAsk,
}: {
  value: BusinessCase;
  story: CaseStory;
  onAsk?: (question: string) => void;
}) {
  const t = useT();
  const { cards } = value;
  const dot = (key: ActKey) =>
    story.acts.find((act) => act.key === key)?.dot ?? "open";
  const showOpen = cards.unknowns.state !== "empty" || value.status !== "ready";
  const scope =
    cards.scope.state === "empty"
      ? {
          ...cards.scope,
          state: "filled" as const,
          summary: value.request.text,
        }
      : cards.scope;

  return (
    <div className="flex flex-col">
      <Act label={t(ACT_LABEL.why)} number="01" dot={dot("why")} first>
        <div>
          <div className="text-xs text-muted-foreground">
            {t("plan.case.objective")}
          </div>
          <p
            className={cn(
              "mt-0.5 text-[17px] leading-snug text-pretty",
              value.objective ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {value.objective ?? t("plan.case.noObjective")}
          </p>
        </div>
        <Step cardKey="problem" card={cards.problem} divider>
          <Comparison card={cards.problem} />
        </Step>
      </Act>

      <Act label={t(ACT_LABEL.what)} number="02" dot={dot("what")}>
        <Step
          cardKey="scope"
          card={scope}
          label={
            cards.scope.state === "empty" ? t("plan.case.request") : undefined
          }
        />
        <Step cardKey="competitors" card={cards.competitors} divider>
          <Competitors card={cards.competitors} />
        </Step>
      </Act>

      <Act label={t(ACT_LABEL.worth)} number="03" dot={dot("worth")}>
        <Step cardKey="money" card={cards.money}>
          <MoneyChain card={cards.money} />
        </Step>
        <Step cardKey="effort" card={cards.effort} divider>
          <MetricChips metrics={cards.effort.metrics ?? []} />
        </Step>
        <Risk card={cards.risks} />
      </Act>

      <Act
        label={t(ACT_LABEL.prove)}
        number="04"
        dot={dot("prove")}
        last={!showOpen}
      >
        <Step cardKey="measurement" card={cards.measurement} />
        <Step cardKey="abTest" card={cards.abTest} divider>
          <AbTestStrip card={cards.abTest} />
        </Step>
      </Act>

      {showOpen && (
        <Act
          label={t(ACT_LABEL.open)}
          number="?"
          dot={cards.unknowns.state === "asking" ? "asking" : "open"}
          last
        >
          {story.openQuestions.length > 0 ? (
            <OpenQuestions questions={story.openQuestions} onAsk={onAsk} />
          ) : (
            <Step cardKey="unknowns" card={cards.unknowns} />
          )}
        </Act>
      )}
    </div>
  );
}

/**
 * The business case as a canvas: the goal and the request on top, then one
 * card per part of the case. Empty cards show the question they answer, the
 * card the chat is asking about is highlighted, and filled cards show what
 * the agent found, with sources and assumptions.
 */

import type { ComponentType, SVGProps } from "react";
import {
  AlertTriangle,
  BarChart10,
  BarLineChart,
  Beaker02,
  CurrencyDollarCircle,
  File06,
  HelpCircle,
  Lightbulb02,
  MessageChatCircle,
  Target04,
  Tool02,
  Users01,
} from "@untitledui/icons";
import {
  BUSINESS_CASE_CARD_KEYS,
  type BusinessCase,
  type BusinessCaseCard,
  type BusinessCaseCardKey,
} from "@decocms/shared/business-case";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const CARDS: Record<
  BusinessCaseCardKey,
  { icon: Icon; title: TranslationKey; question: TranslationKey }
> = {
  problem: {
    icon: BarLineChart,
    title: "plan.case.card.problem",
    question: "plan.case.card.problemQuestion",
  },
  scope: {
    icon: Lightbulb02,
    title: "plan.case.card.scope",
    question: "plan.case.card.scopeQuestion",
  },
  money: {
    icon: CurrencyDollarCircle,
    title: "plan.case.card.money",
    question: "plan.case.card.moneyQuestion",
  },
  competitors: {
    icon: Users01,
    title: "plan.case.card.competitors",
    question: "plan.case.card.competitorsQuestion",
  },
  measurement: {
    icon: BarChart10,
    title: "plan.case.card.measurement",
    question: "plan.case.card.measurementQuestion",
  },
  abTest: {
    icon: Beaker02,
    title: "plan.case.card.abTest",
    question: "plan.case.card.abTestQuestion",
  },
  effort: {
    icon: Tool02,
    title: "plan.case.card.effort",
    question: "plan.case.card.effortQuestion",
  },
  risks: {
    icon: AlertTriangle,
    title: "plan.case.card.risks",
    question: "plan.case.card.risksQuestion",
  },
  unknowns: {
    icon: HelpCircle,
    title: "plan.case.card.unknowns",
    question: "plan.case.card.unknownsQuestion",
  },
};

const STATUS: Record<BusinessCase["status"], TranslationKey> = {
  framing: "plan.case.status.framing",
  building: "plan.case.status.building",
  ready: "plan.case.status.ready",
};

const AREA: Record<BusinessCase["request"]["area"], TranslationKey> = {
  pdp: "plan.case.area.pdp",
  search: "plan.case.area.search",
  category: "plan.case.area.category",
  home: "plan.case.area.home",
  cart: "plan.case.area.cart",
  checkout: "plan.case.area.checkout",
  shipping: "plan.case.area.shipping",
  performance: "plan.case.area.performance",
  "paid-media": "plan.case.area.paidMedia",
  other: "plan.case.area.other",
};

function Eyebrow({ icon: Icon, children }: { icon: Icon; children: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      <Icon size={13} />
      {children}
    </div>
  );
}

function CaseCard({
  cardKey,
  card,
}: {
  cardKey: BusinessCaseCardKey;
  card: BusinessCaseCard;
}) {
  const t = useT();
  const meta = CARDS[cardKey];
  const Icon = meta.icon;

  return (
    <article
      aria-busy={card.state === "asking"}
      className={cn(
        "flex min-h-40 flex-col gap-3 rounded-xl border p-4 transition-colors duration-500",
        card.state === "empty" && "border-dashed bg-transparent",
        card.state === "asking" &&
          "border-primary bg-primary/5 ring-2 ring-primary/15",
        card.state === "filled" && "bg-card",
      )}
    >
      <header className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            card.state === "filled"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon size={15} />
        </span>
        <h3 className="text-sm font-medium text-foreground">{t(meta.title)}</h3>
        {card.state === "asking" && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-primary">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            {t("plan.case.asking")}
          </span>
        )}
      </header>

      {card.state === "filled" ? (
        <div className="flex flex-col gap-2.5 text-sm">
          {card.summary && (
            <p className="text-pretty text-foreground">{card.summary}</p>
          )}
          {card.bullets.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
              {card.bullets.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          )}
          {card.assumption && (
            <p className="rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
              <span className="font-medium">{t("plan.case.assumption")}</span>{" "}
              {card.assumption}
            </p>
          )}
          {card.sources.length > 0 && (
            <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
              {card.sources.map((source, i) =>
                source.url ? (
                  <a
                    key={i}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {source.label}
                  </a>
                ) : (
                  <span
                    key={i}
                    className="max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {source.label}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-pretty text-muted-foreground">
          {t(meta.question)}
        </p>
      )}
    </article>
  );
}

export function BusinessCaseCanvas({
  value,
  invalid,
  onOpenDocument,
}: {
  value: BusinessCase;
  invalid?: boolean;
  onOpenDocument?: (documentPath: string) => void;
}) {
  const t = useT();
  const filled = BUSINESS_CASE_CARD_KEYS.filter(
    (key) => value.cards[key].state === "filled",
  ).length;
  const total = BUSINESS_CASE_CARD_KEYS.length;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Eyebrow icon={File06}>{t("page.businessCase")}</Eyebrow>
          <Badge variant={value.status === "ready" ? "success" : "agent"}>
            {t(STATUS[value.status])}
          </Badge>
        </div>
        <h1 className="max-w-[820px] text-2xl leading-snug font-medium text-balance text-foreground">
          {value.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <div
              className="h-1.5 w-32 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={filled}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${(filled / total) * 100}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {t("plan.case.progress", { filled, total })}
            </span>
          </div>
          {value.documentPath && onOpenDocument && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenDocument(value.documentPath ?? "")}
            >
              <File06 />
              {t("plan.case.openDocument")}
            </Button>
          )}
        </div>
        {invalid && (
          <p className="text-xs text-muted-foreground">
            {t("plan.case.invalid")}
          </p>
        )}
      </header>

      <section className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <Eyebrow icon={Target04}>{t("plan.case.objective")}</Eyebrow>
          <p className="text-base text-pretty text-foreground">
            {value.objective ?? (
              <span className="text-muted-foreground">
                {t("plan.case.noObjective")}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2">
            <Eyebrow icon={MessageChatCircle}>{t("plan.case.request")}</Eyebrow>
            {value.request.area !== "other" && (
              <Badge variant="muted">{t(AREA[value.request.area])}</Badge>
            )}
          </div>
          <p className="text-base whitespace-pre-line text-pretty text-foreground">
            {value.request.text}
          </p>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {BUSINESS_CASE_CARD_KEYS.map((key) => (
          <CaseCard key={key} cardKey={key} card={value.cards[key]} />
        ))}
      </section>
    </div>
  );
}

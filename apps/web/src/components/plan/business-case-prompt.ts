import { BUSINESS_CASE_LIMITS } from "@decocms/shared/business-case";
import type { TFunction } from "@/i18n/use-t.ts";
import type {
  OpportunityDetail,
  OpportunityHypothesis,
} from "./opportunities/diagnosis-schema.ts";
import {
  checkOutcomeLabel,
  DEVICE_LABEL,
  PAGE_LABEL,
  VERDICT_LABEL,
} from "./opportunities/labels.ts";
import { hypothesisLine, safeHref } from "./opportunities/opportunity-view.ts";

type Money = NonNullable<OpportunityDetail["money"]>;
type Experiment = NonNullable<OpportunityHypothesis["experiment"]>;

/** A question of the Plan page's guided intro and what the person said;
 *  an empty answer is a skipped question. */
export interface GuideAnswer {
  question: string;
  answer: string;
}

/** One `- question` line per answer, the answer indented below it;
 *  `skipped` stands in for an empty answer. */
function formatAnswers(answers: GuideAnswer[], skipped: string): string {
  return answers
    .map(
      ({ question, answer }) =>
        `- ${question.trim()}\n  ${answer.trim() || skipped}`,
    )
    .join("\n");
}

/** The skill is named by its path so hosted and sandboxed harnesses can both read it. */
export function businessCasePrompt(
  t: TFunction,
  input: {
    idea: string;
    objective: string | null | undefined;
    /** The case file as the agent sees it (`/app/org/home/plans/cases/…`). */
    casePath: string;
    /** Set when the guided intro already asked what the person knows, even
     *  if it asked nothing: the agent should not ask again. */
    answers?: GuideAnswer[];
  },
): string {
  const idea = input.idea.trim();
  const objective = input.objective?.trim();
  const casePath = input.casePath;
  const base = objective
    ? t("plan.prompt.withObjective", { idea, objective, casePath })
    : t("plan.prompt.withoutObjective", { idea, casePath });
  if (!input.answers) return base;
  const answers = formatAnswers(input.answers, t("plan.prompt.skipped"));
  return `${base}\n\n${
    answers
      ? t("plan.prompt.guidedAnswers", { answers })
      : t("plan.prompt.guidedNothing")
  }`;
}

/** The answers to a case's open questions, sent to its chat in one message
 *  so the agent updates the case in a single turn. */
export function openAnswersPrompt(
  t: TFunction,
  answers: GuideAnswer[],
): string {
  return t("plan.case.openFlow.prompt", {
    answers: formatAnswers(answers, t("plan.case.openFlow.skipped")),
  });
}

/** Most items any list of the analysis's data carries into the prompt. */
const PROMPT_LIST_ITEMS = 5;

/** One line of the analysis's text, capped like a case field. */
function clip(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, BUSINESS_CASE_LIMITS.text);
}

/** Plain digits, so the agent can pass them to the canvas as they are. */
function num(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** An engine rate (0–1) as a percent. */
function pct(rate: number): string {
  return `${num(rate * 100)}%`;
}

function list(heading: string, items: string[]): string[] {
  const shown = items.slice(0, PROMPT_LIST_ITEMS);
  return shown.length === 0 ? [] : [heading, ...shown.map((i) => `- ${i}`)];
}

/** A canvas flag's number: digits, up to 4 decimals. */
function flagNum(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** The analysis's text as a single-quoted canvas label: no quoting or shell
 *  characters, within the canvas's label limit. */
function canvasLabel(text: string, max: number): string {
  return text
    .replace(/['"`$\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * The canvas computes money as base × Δpp × value, with no channel share, so
 * the share goes into the value: the canvas then shows the analysis's figure.
 * A share that is missing or out of range counts as the whole channel.
 */
function canvasMoneyFlags(money: Money, gapPp: number | null): string {
  const share =
    Number.isFinite(money.channel_share) &&
    money.channel_share > 0 &&
    money.channel_share <= 1
      ? money.channel_share
      : 1;
  const max = BUSINESS_CASE_LIMITS.label;
  const suffix = share === 1 ? "" : ` (× ${pct(share)})`;
  const baseLabel = canvasLabel(money.base_label, max);
  const valueLabel = canvasLabel(money.value_label, max - suffix.length);
  return [
    `--base ${flagNum(money.base)}`,
    `--delta-pp ${flagNum(money.delta_pp)}`,
    `--value ${flagNum(money.value_per_event * share)}`,
    ...(gapPp !== null && gapPp > 0 ? [`--gap-pp ${flagNum(gapPp)}`] : []),
    ...(baseLabel ? [`--base-label '${baseLabel}'`] : []),
    ...(valueLabel ? [`--value-label '${valueLabel}${suffix}'`] : []),
  ].join(" ");
}

/** `--weekly` is the step's weekly reach: the canvas applies `--exposure`
 *  itself, so the engine's already-exposed `weekly_eligible` would count it
 *  twice. */
function canvasAbFlags(e: Experiment): string {
  return [
    `--baseline ${flagNum(e.baseline)}`,
    `--effect-pp ${flagNum(e.mde_pp)}`,
    `--weekly ${flagNum(e.weekly_at_step)}`,
    ...(e.exposure > 0 && e.exposure <= 1
      ? [`--exposure ${flagNum(e.exposure)}`]
      : []),
    `--direction ${e.direction === "sobe" ? "up" : "down"}`,
  ].join(" ");
}

/** A fence longer than any backtick run in `body`, so the analysis's text
 *  cannot close the data block early. */
function fenced(body: string): string {
  const longest = Math.max(
    0,
    ...Array.from(body.matchAll(/`+/g), ([run]) => run.length),
  );
  const fence = "`".repeat(Math.max(4, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

function lossLines(t: TFunction, o: OpportunityDetail): string[] {
  const lines = [
    t("plan.prompt.fromOpportunity.loss", { title: clip(o.title) }),
    t("plan.prompt.fromOpportunity.where", {
      page: t(PAGE_LABEL[o.page_type]),
      device: t(DEVICE_LABEL[o.device]),
    }),
    t("plan.prompt.fromOpportunity.summary", { summary: clip(o.summary) }),
  ];
  const m = o.measured;
  if (m) {
    lines.push(
      t("plan.prompt.fromOpportunity.measured", {
        label: clip(m.label),
        device: t(DEVICE_LABEL[m.device]),
        rate: pct(m.rate),
        hits: num(m.hits),
        n: num(m.n),
        source: clip(m.source),
        days: num(m.window_days),
      }),
    );
    if (m.comp) {
      lines.push(
        t("plan.prompt.fromOpportunity.compared", {
          device: t(DEVICE_LABEL[m.comp.device]),
          rate: pct(m.comp.rate),
          hits: num(m.comp.hits),
          n: num(m.comp.n),
          gap: m.gap_pp === null ? "?" : num(m.gap_pp),
        }),
      );
    }
  }
  const money = o.money;
  if (money) {
    lines.push(
      t("plan.prompt.fromOpportunity.money", {
        monthly: num(money.monthly_value),
        base: num(money.base),
        baseLabel: clip(money.base_label),
        delta: num(money.delta_pp),
        value: num(money.value_per_event),
        valueLabel: clip(money.value_label),
        share: pct(money.channel_share),
      }),
      t("plan.prompt.fromOpportunity.assumption", {
        assumption: clip(money.assumption),
      }),
    );
    if (money.ceiling_monthly !== null) {
      lines.push(
        t("plan.prompt.fromOpportunity.ceiling", {
          ceiling: num(money.ceiling_monthly),
        }),
      );
    }
    lines.push(
      t("plan.prompt.fromOpportunity.canvas.money", {
        flags: canvasMoneyFlags(money, o.measured?.gap_pp ?? null),
      }),
    );
  } else {
    lines.push(t("plan.prompt.fromOpportunity.noMoney"));
  }
  lines.push(
    ...list(
      t("plan.prompt.fromOpportunity.sources"),
      o.sources.map((s) =>
        clip(
          `${s.source} · ${s.metric}: ${s.value}${s.window ? ` (${s.window})` : ""}`,
        ),
      ),
    ),
    ...list(
      t("plan.prompt.fromOpportunity.observed"),
      (o.observations ?? []).map((obs) => clip(obs.text)),
    ),
  );
  return lines;
}

function hypothesisLines(t: TFunction, h: OpportunityHypothesis): string[] {
  const lines = [
    t("plan.prompt.fromOpportunity.hypothesis", { title: clip(h.title) }),
  ];
  if (h.why.trim()) {
    lines.push(t("plan.prompt.fromOpportunity.why", { why: clip(h.why) }));
  }
  if (h.idea.trim()) {
    lines.push(t("plan.prompt.fromOpportunity.idea", { idea: clip(h.idea) }));
  }
  if (h.where.trim()) {
    lines.push(
      t("plan.prompt.fromOpportunity.whereChange", { where: clip(h.where) }),
    );
  }
  lines.push(
    t("plan.prompt.fromOpportunity.verdict", {
      verdict: t(VERDICT_LABEL[hypothesisLine(h).verdict]),
    }),
  );
  const v = h.verification;
  if (v) {
    lines.push(
      t("plan.prompt.fromOpportunity.verification", {
        summary: clip(v.summary),
      }),
      ...list(
        t("plan.prompt.fromOpportunity.checks"),
        v.runs.map((run) => {
          const outcome = checkOutcomeLabel(run.outcome);
          return clip(
            outcome
              ? t("plan.prompt.fromOpportunity.check", {
                  claim: run.check.claim,
                  outcome: t(outcome),
                  observed: run.observed,
                })
              : t("plan.prompt.fromOpportunity.checkNoOutcome", {
                  claim: run.check.claim,
                  observed: run.observed,
                }),
          );
        }),
      ),
    );
  }
  lines.push(
    ...list(
      t("plan.prompt.fromOpportunity.citations"),
      h.citations.map((c) => {
        const url = safeHref(c.fonte_url);
        const source = url ? `${clip(c.fonte)} (${clip(url)})` : clip(c.fonte);
        return c.trecho ? `${source}: "${clip(c.trecho)}"` : source;
      }),
    ),
  );
  return lines;
}

function experimentLines(t: TFunction, h: OpportunityHypothesis): string[] {
  const e = h.experiment;
  if (!e) return [t("plan.prompt.fromOpportunity.noExperiment")];
  const lines = [
    t("plan.prompt.fromOpportunity.experiment"),
    t("plan.prompt.fromOpportunity.experiment.arms", {
      control: clip(e.controle),
      variant: clip(e.variante),
    }),
    t("plan.prompt.fromOpportunity.experiment.metric", {
      label: clip(e.metrica_primaria.label),
      device: t(DEVICE_LABEL[e.metrica_primaria.device]),
      baseline: pct(e.baseline),
      direction:
        e.direction === "sobe"
          ? t("plan.prompt.fromOpportunity.experiment.up")
          : t("plan.prompt.fromOpportunity.experiment.down"),
      mde: num(e.mde_pp),
    }),
  ];
  const guardrails = e.guardrails.slice(0, PROMPT_LIST_ITEMS).map(clip);
  if (guardrails.length > 0) {
    lines.push(
      t("plan.prompt.fromOpportunity.experiment.guardrails", {
        guardrails: guardrails.join("; "),
      }),
    );
  }
  lines.push(
    t("plan.prompt.fromOpportunity.experiment.sample", {
      weekly: num(e.weekly_at_step),
      exposure: pct(e.exposure),
      eligible: num(e.weekly_eligible),
      n: num(e.n_per_group),
      weeks: num(e.weeks),
    }),
  );
  if (!e.measurable) {
    lines.push(
      e.mde_4_weeks_pp === null
        ? t("plan.prompt.fromOpportunity.experiment.notMeasurable")
        : t("plan.prompt.fromOpportunity.experiment.notMeasurableMde", {
            mde: num(e.mde_4_weeks_pp),
          }),
    );
  }
  lines.push(
    ...list(
      t("plan.prompt.fromOpportunity.experiment.limitations"),
      e.limitacoes.map(clip),
    ),
    t("plan.prompt.fromOpportunity.canvas.abTest", { flags: canvasAbFlags(e) }),
  );
  return lines;
}

/**
 * Starts a case from a loss the store analysis measured. Its numbers go in as
 * measured, and its text, read from store pages and written by a model, goes
 * in a fenced block the prompt names as data.
 */
export function opportunityCasePrompt(
  t: TFunction,
  input: {
    opportunity: OpportunityDetail;
    hypothesis: OpportunityHypothesis;
    objective: string | null;
    /** The case file as the agent sees it (`/app/org/home/plans/cases/…`). */
    casePath: string;
  },
): string {
  const { opportunity, hypothesis, casePath } = input;
  const objective = input.objective?.trim();
  const discarded = opportunity.hypotheses
    .filter(
      (h) => h.id !== hypothesis.id && hypothesisLine(h).verdict === "refuted",
    )
    .toSorted((a, b) => a.rank - b.rank)
    .map((h) => `${clip(h.title)}: ${clip(h.verification?.summary || h.why)}`);
  const data = [
    ...lossLines(t, opportunity),
    "",
    ...hypothesisLines(t, hypothesis),
    "",
    ...experimentLines(t, hypothesis),
    ...(discarded.length > 0
      ? ["", ...list(t("plan.prompt.fromOpportunity.discarded"), discarded)]
      : []),
  ].join("\n");
  const intro = objective
    ? t("plan.prompt.fromOpportunity.withObjective", { casePath, objective })
    : t("plan.prompt.fromOpportunity.withoutObjective", { casePath });
  const canvas = [
    ...(opportunity.money
      ? [
          t("plan.prompt.fromOpportunity.canvas.moneyRule", {
            monthly: num(opportunity.money.monthly_value),
          }),
        ]
      : []),
    ...(hypothesis.experiment
      ? [t("plan.prompt.fromOpportunity.canvas.abTestRule")]
      : []),
  ];
  const rules = canvas.length > 0 ? `\n\n${canvas.join(" ")}` : "";
  return `${intro}${rules}\n\n${fenced(data)}`;
}

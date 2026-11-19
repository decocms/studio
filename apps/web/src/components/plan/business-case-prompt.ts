import type { TFunction } from "@/i18n/use-t.ts";

/** A question of the Plan page's guided intro and what the person said;
 *  an empty answer is a skipped question. */
export interface GuideAnswer {
  question: string;
  answer: string;
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
  const answers = input.answers
    .map(
      ({ question, answer }) =>
        `- ${question.trim()}\n  ${answer.trim() || t("plan.prompt.skipped")}`,
    )
    .join("\n");
  return `${base}\n\n${
    answers
      ? t("plan.prompt.guidedAnswers", { answers })
      : t("plan.prompt.guidedNothing")
  }`;
}

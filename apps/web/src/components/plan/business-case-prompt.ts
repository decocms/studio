import type { TFunction } from "@/i18n/use-t.ts";

/** The skill is named by its path so hosted and sandboxed harnesses can both read it. */
export function businessCasePrompt(
  t: TFunction,
  input: {
    idea: string;
    objective: string | null | undefined;
    /** The case file as the agent sees it (`/app/org/home/plans/cases/…`). */
    casePath: string;
  },
): string {
  const idea = input.idea.trim();
  const objective = input.objective?.trim();
  const casePath = input.casePath;
  return objective
    ? t("plan.prompt.withObjective", { idea, objective, casePath })
    : t("plan.prompt.withoutObjective", { idea, casePath });
}

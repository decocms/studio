import type { TFunction } from "@/i18n/use-t.ts";

/**
 * The chat message "Create the plan" sends: the idea, the store goal when
 * there is one, and a pointer to the business-case skill. The skill is named
 * by its path so both the hosted agent and a sandboxed harness can read it.
 */
export function businessCasePrompt(
  t: TFunction,
  input: { idea: string; objective: string | null | undefined },
): string {
  const idea = input.idea.trim();
  const objective = input.objective?.trim();
  return objective
    ? t("plan.prompt.withObjective", { idea, objective })
    : t("plan.prompt.withoutObjective", { idea });
}

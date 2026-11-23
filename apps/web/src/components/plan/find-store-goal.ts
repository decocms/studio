import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import type { TranslationKey } from "@/i18n/en/index.ts";

export type GoalFinding = StudioToolOutput<"ORGANIZATION_PLAN_OBJECTIVE_FIND">;

/** What the page says under the goal input after Find with AI answers. */
export type FindNotice =
  | { kind: "found"; statement: string; source: string; quote: string }
  | {
      kind: "missing";
      message: TranslationKey;
      read: string[];
      unread: string[];
    };

export function findNotice(result: GoalFinding): FindNotice {
  if (result.found) {
    return {
      kind: "found",
      statement: result.found.statement,
      source: result.found.source.label,
      quote: result.found.quote,
    };
  }
  return {
    kind: "missing",
    message:
      result.reason === "unavailable"
        ? "plan.objective.findUnavailable"
        : "plan.objective.notFound",
    read: result.read,
    unread: result.unread,
  };
}

/**
 * Whether a goal Find with AI found can go straight into the input: only
 * while the person has not written their own (empty, or still the saved
 * goal). Otherwise it is offered beside what they wrote.
 */
export function findFills(draft: string, saved: string): boolean {
  const mine = draft.trim();
  return !mine || mine === saved.trim();
}

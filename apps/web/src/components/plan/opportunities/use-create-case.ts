/**
 * "Create business case" from a loss's ready hypothesis, on the Plan cards and
 * on the loss's page. The prompt needs the loss's full detail, so a card
 * fetches it first through the page's cache entry. One case starts at a time.
 */

import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useChatTask } from "@/components/chat";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useStudioTools } from "@/lib/studio-tools";
import { opportunityCasePrompt } from "../business-case-prompt.ts";
import { startBusinessCase } from "../start-business-case.ts";
import { useActivePlanGoal } from "../use-active-goal.ts";
import type { OpportunityDetail } from "./diagnosis-schema.ts";
import { errorText } from "./opportunity-view.ts";
import { useFetchOpportunity } from "./use-plan-diagnosis.ts";

/** Where a loss's "Create business case" stands. */
export interface CaseCreation {
  /** This loss's case is being started. */
  busy: boolean;
  /** Another case is being started, or the goal is still loading. */
  disabled: boolean;
  failed: boolean;
  /** The failure's own message, shown under a translated headline. */
  error: string | null;
}

interface CreateCaseInput {
  opportunityId: string;
  hypothesisId: string;
  /** The loss, when the page already has it. */
  detail?: OpportunityDetail;
}

export function useCreateCaseFromOpportunity() {
  const t = useT();
  const studio = useStudioTools();
  const { createTaskWithMessage } = useChatTask();
  const fetchOpportunity = useFetchOpportunity();
  const { goal, pending: goalPending } = useActivePlanGoal();
  /** Set before React renders the mutation as pending, so a double click
   *  starts one case. */
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: async ({
      opportunityId,
      hypothesisId,
      detail,
    }: CreateCaseInput) => {
      const opportunity = detail ?? (await fetchOpportunity(opportunityId));
      const hypothesis = opportunity.hypotheses.find(
        (h) => h.id === hypothesisId,
      );
      if (!hypothesis) {
        throw new Error(t("plan.opportunities.createCase.missing"));
      }
      const created = await startBusinessCase(
        { studio, createTaskWithMessage, storage: sessionStorage },
        {
          goalId: goal.id,
          objective: goal.statement,
          request: opportunity.title,
          title: hypothesis.title,
          prompt: (casePath) =>
            opportunityCasePrompt(t, {
              opportunity,
              hypothesis,
              objective: goal.statement,
              casePath,
            }),
        },
      );
      if (created) {
        track("plan_opportunity_case_created", {
          page_type: opportunity.page_type,
          has_goal: !!(goal.id || goal.statement?.trim()),
        });
      }
      return created;
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const forId = mutation.variables?.opportunityId ?? null;
  return {
    create: (input: CreateCaseInput) => {
      if (inFlight.current || goalPending) return;
      inFlight.current = true;
      mutation.mutate(input);
    },
    status: (opportunityId: string): CaseCreation => {
      const mine = forId === opportunityId;
      return {
        busy: mine && mutation.isPending,
        disabled: mutation.isPending || goalPending,
        failed: mine && mutation.isError,
        error: mine ? errorText(mutation.error) : null,
      };
    },
  };
}

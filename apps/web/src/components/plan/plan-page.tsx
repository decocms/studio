/** Plan: the goal, the request composer, what the store analysis found, and
 *  the cases already started. While the guided intro runs, its screens take
 *  the whole page. With Plan goals on, the goal is the one this member works
 *  toward, picked from the organization's goals; otherwise it is the single
 *  store goal. */

import { useState } from "react";
import { Page } from "@/components/page";
import {
  useOrgFlag,
  usePlanObjective,
} from "@/hooks/use-organization-settings";
import { usePlanGoals, usePlanGoalsLive } from "@/hooks/use-plan-goals";
import { PlanGuide } from "./guide/plan-guide.tsx";
import { PlanGuideResume } from "./guide/plan-guide-resume.tsx";
import { usePlanGuide } from "./guide/use-plan-guide.ts";
import { OpportunitiesSection } from "./opportunities/opportunities-section.tsx";
import { PlanCasesList } from "./plan-cases-list.tsx";
import { PlanGoalsSection } from "./plan-goals.tsx";
import { PlanIdeaComposer } from "./plan-idea-composer.tsx";
import { PlanObjective } from "./plan-objective.tsx";

export function PlanPage() {
  const goalsOn = useOrgFlag("plan_goals_enabled");
  usePlanGoalsLive();
  const goals = usePlanGoals(goalsOn);
  const storeGoal = usePlanObjective()?.statement ?? null;
  const goal = goalsOn
    ? {
        statement: goals.active?.statement ?? null,
        id: goals.active?.id ?? null,
      }
    : { statement: storeGoal, id: null };
  const guide = usePlanGuide(goal);
  // Going back from the intro puts the idea back in the composer.
  const [draft, setDraft] = useState("");
  const { state } = guide;
  if (state) {
    return (
      <Page>
        <PlanGuide
          guide={{
            ...guide,
            state,
            cancel: () => {
              setDraft(state.idea);
              guide.cancel();
            },
          }}
        />
      </Page>
    );
  }
  return (
    <Page>
      <Page.Content>
        <Page.Container width="standard" className="flex flex-col gap-12">
          {goalsOn ? <PlanGoalsSection goals={goals} /> : <PlanObjective />}
          {guide.saved && (
            <PlanGuideResume
              draft={guide.saved}
              onResume={guide.resume}
              onDiscard={guide.discard}
            />
          )}
          <PlanIdeaComposer initialIdea={draft} onSubmit={guide.start} />
          <OpportunitiesSection goal={goal} />
          <PlanCasesList goalId={goal.id} />
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

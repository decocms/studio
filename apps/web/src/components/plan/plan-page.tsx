/** Plan: the store goal, the request composer, and the cases already started. */

import { Page } from "@/components/page";
import { PlanCasesList } from "./plan-cases-list.tsx";
import { PlanIdeaComposer } from "./plan-idea-composer.tsx";
import { PlanObjective } from "./plan-objective.tsx";

export function PlanPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Container width="standard" className="flex flex-col gap-12">
          <PlanObjective />
          <PlanIdeaComposer />
          <PlanCasesList />
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

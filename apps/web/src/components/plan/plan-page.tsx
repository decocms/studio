/**
 * Plan: the store goal on top, then the idea composer that turns an idea into
 * a business case. Proactive opportunities come later
 * (docs/plans/plan-page.md, phases F2 onward).
 */

import { Page } from "@/components/page";
import { PlanIdeaComposer } from "./plan-idea-composer.tsx";
import { PlanObjective } from "./plan-objective.tsx";

export function PlanPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Container width="standard" className="flex flex-col gap-12">
          <PlanObjective />
          <PlanIdeaComposer />
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

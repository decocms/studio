/** Plan: the store goal, the request composer, and the cases already started.
 *  While the guided intro runs, its screens take the whole page. */

import { useState } from "react";
import { Page } from "@/components/page";
import { PlanGuide } from "./guide/plan-guide.tsx";
import { usePlanGuide } from "./guide/use-plan-guide.ts";
import { PlanCasesList } from "./plan-cases-list.tsx";
import { PlanIdeaComposer } from "./plan-idea-composer.tsx";
import { PlanObjective } from "./plan-objective.tsx";

export function PlanPage() {
  const guide = usePlanGuide();
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
          <PlanObjective />
          <PlanIdeaComposer initialIdea={draft} onSubmit={guide.start} />
          <PlanCasesList />
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

/** Plan: the goal, the request composer, what the store analysis found, and
 *  the cases already started; the Store tab shows the analysis page by page.
 *  While the guided intro runs, its screens take the whole page. With Plan
 *  goals on, the goal is the one this member works toward, picked from the
 *  organization's goals; otherwise it is the single store goal. */

import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ErrorBoundary } from "@/components/error-boundary";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { usePlanGoalsLive } from "@/hooks/use-plan-goals";
import { useScopeId } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { PlanGuide } from "./guide/plan-guide.tsx";
import { PlanGuideResume } from "./guide/plan-guide-resume.tsx";
import { usePlanGuide } from "./guide/use-plan-guide.ts";
import {
  OpportunitiesSection,
  OpportunitiesSectionFallback,
} from "./opportunities/opportunities-section.tsx";
import { NewRunPopover } from "./opportunities/new-run-popover.tsx";
import { StoreTab } from "./opportunities/store-tab.tsx";
import { useCreateCaseFromOpportunity } from "./opportunities/use-create-case.ts";
import { PlanCasesList } from "./plan-cases-list.tsx";
import { PlanGoalsSection } from "./plan-goals.tsx";
import { PlanIdeaComposer } from "./plan-idea-composer.tsx";
import { PlanObjective } from "./plan-objective.tsx";
import { useActivePlanGoal } from "./use-active-goal.ts";

/** Opens a loss's page, inside the project when Plan is open in one. */
function useOpenOpportunity() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const scopeId = useScopeId();
  return (opportunityId: string) =>
    scopeId
      ? navigate({
          to: PROJECT_ROUTE.planOpportunity,
          params: { org: org.slug, agentId: scopeId, opportunityId },
        })
      : navigate({
          to: DESTINATION_ROUTE.planOpportunity,
          params: { org: org.slug, opportunityId },
        });
}

type PlanTab = "plan" | "store";

/** The route validates `tab`; anything it drops is the plan. */
function usePlanTab(): [PlanTab, (tab: PlanTab) => void] {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const scopeId = useScopeId();
  const tab: PlanTab =
    "tab" in search && search.tab === "store" ? "store" : "plan";
  const setTab = (next: PlanTab) => {
    const nextSearch = { tab: next === "plan" ? undefined : next };
    void (scopeId
      ? navigate({
          to: PROJECT_ROUTE.plan,
          params: { org: org.slug, agentId: scopeId },
          search: nextSearch,
        })
      : navigate({
          to: DESTINATION_ROUTE.plan,
          params: { org: org.slug },
          search: nextSearch,
        }));
  };
  return [tab, setTab];
}

/** In the panel's toolbar, like the Monitor's tabs. */
function PlanTabs({
  tab,
  onTab,
}: {
  tab: PlanTab;
  onTab: (tab: PlanTab) => void;
}) {
  const t = useT();
  const tabs = (
    <Page.Tabs>
      <Page.Tab active={tab === "plan"} onClick={() => onTab("plan")}>
        {t("plan.tabs.plan")}
      </Page.Tab>
      <Page.Tab active={tab === "store"} onClick={() => onTab("store")}>
        {t("plan.tabs.store")}
      </Page.Tab>
    </Page.Tabs>
  );
  return (
    <Panel.Toolbar.Left.Portal fallback={tabs}>
      {tabs}
    </Panel.Toolbar.Left.Portal>
  );
}

export function PlanPage() {
  usePlanGoalsLive();
  const { goalsOn, goals, goal } = useActivePlanGoal();
  const guide = usePlanGuide(goal);
  const openOpportunity = useOpenOpportunity();
  const createCase = useCreateCaseFromOpportunity();
  const [tab, setTab] = usePlanTab();
  // The "Nova análise" button that opened the popover; null when closed.
  const [newRunAnchor, setNewRunAnchor] = useState<HTMLElement | null>(null);
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
  const store = tab === "store";
  return (
    <Page>
      <PlanTabs tab={tab} onTab={setTab} />
      {newRunAnchor && (
        <NewRunPopover
          anchor={newRunAnchor}
          goal={goal}
          onClose={() => setNewRunAnchor(null)}
        />
      )}
      <Page.Content>
        <Page.Container
          width={store ? "wide" : "standard"}
          className="flex flex-col gap-12"
        >
          {store ? (
            <ErrorBoundary
              fallback={(props) => <OpportunitiesSectionFallback {...props} />}
            >
              <StoreTab
                goal={goal}
                onNewRun={setNewRunAnchor}
                onOpenOpportunity={(id) => void openOpportunity(id)}
              />
            </ErrorBoundary>
          ) : (
            <>
              {goalsOn ? <PlanGoalsSection goals={goals} /> : <PlanObjective />}
              {guide.saved && (
                <PlanGuideResume
                  draft={guide.saved}
                  onResume={guide.resume}
                  onDiscard={guide.discard}
                />
              )}
              <PlanIdeaComposer initialIdea={draft} onSubmit={guide.start} />
              <ErrorBoundary
                fallback={(props) => (
                  <OpportunitiesSectionFallback {...props} />
                )}
              >
                <OpportunitiesSection
                  goal={goal}
                  onOpenOpportunity={(id) => void openOpportunity(id)}
                  onCreateCase={(opportunity, hypothesis) =>
                    createCase.create({
                      opportunityId: opportunity.id,
                      hypothesisId: hypothesis.id,
                    })
                  }
                  caseCreation={createCase.status}
                  onNewRun={setNewRunAnchor}
                  onOpenStore={() => setTab("store")}
                />
              </ErrorBoundary>
              <PlanCasesList goalId={goal.id} />
            </>
          )}
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

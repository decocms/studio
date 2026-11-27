/** Plan: the goal, what the store analysis found, and the cases already
 *  started; the Store tab shows the analysis page by page. The idea button
 *  beside the goal opens the idea screen in place of the page, and the guided
 *  intro it starts takes the whole page too. With Plan goals on, the goal is
 *  the one this member works toward, picked from the organization's goals;
 *  otherwise it is the single store goal. */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ErrorBoundary,
  type ErrorFallbackProps,
} from "@/components/error-boundary";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { usePlanGoalsLive } from "@/hooks/use-plan-goals";
import { useScopeId } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
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
import { PlanIdeaScreen, ProposeIdeaButton } from "./plan-idea-screen.tsx";
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

/** The analysis's fallback. Trying again drops the cached reads, so the
 *  section does not render the data that failed it again. */
function useDiagnosisFallback() {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  return ({ error, resetError }: ErrorFallbackProps) => (
    <OpportunitiesSectionFallback
      error={error}
      resetError={() => {
        void queryClient.resetQueries({
          queryKey: KEYS.planDiagnosisAll(org.id),
        });
        resetError();
      }}
    />
  );
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
  const { goalsOn, goals, goal, pending } = useActivePlanGoal();
  const runGoal = { ...goal, pending };
  const guide = usePlanGuide(goal);
  const openOpportunity = useOpenOpportunity();
  const createCase = useCreateCaseFromOpportunity();
  const diagnosisFallback = useDiagnosisFallback();
  const [tab, setTab] = usePlanTab();
  // The "Nova análise" button that opened the popover; null when closed.
  const [newRunAnchor, setNewRunAnchor] = useState<HTMLElement | null>(null);
  // The idea screen is open; going back from the intro reopens it with the idea.
  const [composing, setComposing] = useState(false);
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
              setComposing(true);
              guide.cancel();
            },
          }}
        />
      </Page>
    );
  }
  if (composing) {
    return (
      <Page>
        <PlanIdeaScreen
          initialIdea={draft}
          onBack={(idea) => {
            setDraft(idea);
            setComposing(false);
          }}
          onSubmit={(idea) => {
            setComposing(false);
            guide.start(idea);
          }}
        />
      </Page>
    );
  }
  const proposeIdea = <ProposeIdeaButton onClick={() => setComposing(true)} />;
  const store = tab === "store";
  return (
    <Page>
      <PlanTabs tab={tab} onTab={setTab} />
      {newRunAnchor && (
        <NewRunPopover
          anchor={newRunAnchor}
          goal={runGoal}
          onClose={() => setNewRunAnchor(null)}
        />
      )}
      <Page.Content>
        <Page.Container
          width={store ? "wide" : "standard"}
          className="flex flex-col gap-12"
        >
          {store ? (
            <ErrorBoundary fallback={diagnosisFallback}>
              <StoreTab
                goal={runGoal}
                onNewRun={setNewRunAnchor}
                onOpenOpportunity={(id) => void openOpportunity(id)}
              />
            </ErrorBoundary>
          ) : (
            <>
              {goalsOn ? (
                <PlanGoalsSection goals={goals} action={proposeIdea} />
              ) : (
                <PlanObjective action={proposeIdea} />
              )}
              {guide.saved && (
                <PlanGuideResume
                  draft={guide.saved}
                  onResume={guide.resume}
                  onDiscard={guide.discard}
                />
              )}
              <ErrorBoundary fallback={diagnosisFallback}>
                <OpportunitiesSection
                  goal={runGoal}
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

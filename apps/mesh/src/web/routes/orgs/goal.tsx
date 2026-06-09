import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  GoalDetailView,
  GoalsListView,
} from "@/web/views/deco-redesign/goal-detail";

export default function GoalRoute() {
  const navigate = useNavigate();
  const { org } = useParams({ strict: false }) as { org?: string };
  const { g } = useSearch({ strict: false }) as { g?: string };

  const openGoal = (id: string) => {
    if (org) navigate({ to: "/$org/goal", params: { org }, search: { g: id } });
  };
  const back = () => {
    if (org) navigate({ to: "/$org/goal", params: { org }, search: {} });
  };
  const openFinding = (id: string) => {
    if (org) navigate({ to: "/$org/$taskId", params: { org, taskId: id } });
  };

  return (
    <div className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="relative flex flex-col h-full bg-background overflow-hidden card-shadow rounded-[0.75rem]">
          {g ? (
            <GoalDetailView
              goalId={g}
              onBack={back}
              onOpenFinding={openFinding}
            />
          ) : (
            <GoalsListView onOpenGoal={openGoal} />
          )}
        </div>
      </div>
    </div>
  );
}

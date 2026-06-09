/**
 * OrgHome — leaf component for /$org/.
 *
 * Redesign: Deco's brief (System Health). Findings are REAL threads (seeded
 * into the thread manager), so opening one navigates to the real chat route
 * `/$org/$taskId` — the normal task/thread UI, rendering the finding's seeded
 * messages + tool UIs. `?new=1` opens the New Task composer (real Chat.Input).
 */

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { HomeBackground } from "@/web/layouts/home-page/background";
import { RedesignHome } from "@/web/views/deco-redesign/home";
import { NewTaskDialog } from "@/web/views/deco-redesign/new-task-dialog";

export default function OrgHome() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { org } = useParams({ strict: false }) as { org?: string };
  const search = useSearch({ strict: false }) as { new?: string };

  const openTask = (id: string) => {
    if (org) navigate({ to: "/$org/$taskId", params: { org, taskId: id } });
  };
  const openNew = () => {
    if (org) navigate({ to: "/$org", params: { org }, search: { new: "1" } });
  };
  const closeNew = () => {
    if (org) navigate({ to: "/$org", params: { org }, search: {} });
  };
  const openInbox = () => {
    if (org) navigate({ to: "/$org/inbox", params: { org } });
  };
  const openGoal = (id: string) => {
    if (org) navigate({ to: "/$org/goal", params: { org }, search: { g: id } });
  };

  const content = (
    <RedesignHome
      onOpen={openTask}
      onNewTask={openNew}
      onOpenInbox={openInbox}
      onOpenGoal={openGoal}
    />
  );
  const dialog = <NewTaskDialog open={search.new === "1"} onClose={closeNew} />;

  if (isMobile) {
    return (
      <div className="relative flex-1 min-h-0 flex flex-col bg-background overflow-hidden">
        <HomeBackground />
        <div className="relative flex-1 min-h-0 overflow-y-auto">{content}</div>
        {dialog}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="relative flex flex-col h-full bg-background overflow-hidden card-shadow rounded-[0.75rem]">
          <HomeBackground />
          <div className="relative flex-1 min-h-0 overflow-y-auto">
            {content}
          </div>
        </div>
      </div>
      {dialog}
    </div>
  );
}

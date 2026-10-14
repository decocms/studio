/**
 * Task board analytics, for the org or (under `/projects/$agentId`) one project.
 */

import { ChatLayout } from "@/components/chat-layout";
import { BoardAnalytics } from "@/layouts/task-board/board-analytics";
import { taskSharePath } from "@/layouts/task-board/task-route";
import { useTaskBoardAdminOrgs } from "@/hooks/use-task-board-analytics";
import { useT } from "@/i18n/use-t";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";

export default function TaskBoardAnalyticsRoute() {
  const t = useT();
  const params = useParams({ strict: false });
  const orgSlug = params.org ?? "";
  const project = params.agentId;
  const admin = useTaskBoardAdminOrgs();
  // Resets the picker to the new org whenever the URL org changes.
  const [prevOrgSlug, setPrevOrgSlug] = useState(orgSlug);
  const [org, setOrg] = useState<string>(orgSlug);
  if (orgSlug !== prevOrgSlug) {
    setPrevOrgSlug(orgSlug);
    setOrg(orgSlug);
  }

  // A project lives in one org, so its page has no cross-org picker.
  const isAdmin = !project && (admin.data?.isTaskBoardAdmin ?? false);
  const orgOptions = [
    { value: orgSlug, label: t("taskBoard.analytics.orgCurrent") },
    { value: "all", label: t("taskBoard.analytics.orgAll") },
    ...(admin.data?.orgs ?? [])
      .filter((o) => o.slug !== orgSlug)
      .map((o) => ({ value: o.slug, label: `${o.slug} · ${o.name}` })),
  ];
  // Another org's card opens on your own board pointed at it (`?boardOrg=`).
  const taskHref = (taskId: string) =>
    taskSharePath(orgSlug, { id: taskId, keySeq: null }, project) +
    (org === orgSlug ? "" : `?boardOrg=${encodeURIComponent(org)}`);

  return (
    <ChatLayout.Content>
      <BoardAnalytics
        key={org}
        org={org}
        project={project}
        taskHref={org === "all" ? undefined : taskHref}
        showTenants={isAdmin}
        actions={
          isAdmin && (
            <Combobox
              options={orgOptions}
              value={org}
              onChange={setOrg}
              width="w-[220px]"
              searchPlaceholder={t("taskBoard.analytics.orgSearch")}
              emptyMessage={t("taskBoard.analytics.orgEmpty")}
            />
          )
        }
        notice={
          org !== orgSlug && (
            <div className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              {org === "all"
                ? t("taskBoard.analytics.bannerAll")
                : t("taskBoard.analytics.bannerOrg", { org })}
            </div>
          )
        }
      />
    </ChatLayout.Content>
  );
}

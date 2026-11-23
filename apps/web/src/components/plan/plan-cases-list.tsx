/**
 * The business cases on Plan, newest first: the ones this member started, or,
 * with Plan goals on, also the ones anyone started toward the member's goal.
 * Opening one goes back to its chat with the canvas beside it.
 */

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChevronRight, File06 } from "@untitledui/icons";
import {
  BUSINESS_CASE_DIR,
  matchBusinessCasePath,
} from "@decocms/shared/business-case";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { useChatTask } from "@/components/chat";
import { useDateFnsLocale } from "@/hooks/use-date-fns-locale.ts";
import { useOrgFsList, type OrgFsEntry } from "@/hooks/use-org-fs";
import { usePlanGoalCases } from "@/hooks/use-plan-goals";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { formatCaseTabId } from "@/layouts/main-panel-tabs/tab-id";
import { authClient } from "@/lib/auth-client";
import { useBusinessCase } from "./business-case/use-business-case.ts";

const MAX_CASES = 20;

const STATUS: Record<"framing" | "building" | "ready", TranslationKey> = {
  framing: "plan.case.status.framing",
  building: "plan.case.status.building",
  ready: "plan.case.status.ready",
};

function CaseRow({ entry, threadId }: { entry: OrgFsEntry; threadId: string }) {
  const t = useT();
  const locale = useDateFnsLocale();
  const { openTask } = useChatTask();
  const read = useBusinessCase(entry.path);
  const value = read.data?.value;

  return (
    <li>
      <button
        type="button"
        onClick={() =>
          openTask(threadId, { tabId: formatCaseTabId(entry.path) })
        }
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent focus-ring"
      >
        <File06 className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {value?.title ??
              (read.isPending ? "…" : t("plan.cases.unreadable"))}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("plan.cases.updated", {
              when: formatDistanceToNow(new Date(entry.updatedAt), {
                addSuffix: true,
                locale,
              }),
            })}
          </span>
        </span>
        {value && (
          <Badge variant={value.status === "ready" ? "success" : "agent"}>
            {t(STATUS[value.status])}
          </Badge>
        )}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

type CasesView = "goal" | "mine";

export function PlanCasesList({
  goalId,
}: {
  /** The member's Plan goal; null without Plan goals, which lists only theirs. */
  goalId: string | null;
}) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const [picked, setPicked] = useState<CasesView>("goal");
  const view: CasesView = goalId ? picked : "mine";
  const goalCases = usePlanGoalCases(goalId);
  const towardGoal = new Set(goalCases ?? []);
  const list = useOrgFsList("home", BUSINESS_CASE_DIR);
  const all = (list.data ?? []).flatMap((entry) => {
    const threadId = matchBusinessCasePath(entry.path);
    return entry.kind === "file" && threadId ? [{ entry, threadId }] : [];
  });
  const mine = all.filter(
    ({ entry }) => !entry.createdBy || entry.createdBy === userId,
  );
  const cases = (
    view === "goal"
      ? all.filter(({ threadId }) => towardGoal.has(threadId))
      : mine
  )
    .toSorted((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, MAX_CASES);

  if (!goalId && cases.length === 0) return null;
  if (goalId && mine.length === 0 && towardGoal.size === 0) return null;

  const tab = (value: CasesView, label: string) => (
    <Button
      variant={view === value ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={view === value}
      onClick={() => setPicked(value)}
    >
      {label}
    </Button>
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-medium text-foreground">
          {view === "goal"
            ? t("plan.cases.towardGoal")
            : t("plan.cases.heading")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {view === "goal"
            ? t("plan.cases.towardGoalDescription")
            : t("plan.cases.description")}
        </p>
      </div>
      {goalId && (
        <div className="flex gap-1">
          {tab("goal", t("plan.cases.towardGoal"))}
          {tab("mine", t("plan.cases.mine"))}
        </div>
      )}
      {cases.length === 0 ? (
        view === "goal" && (
          <p className="text-sm text-muted-foreground">
            {t("plan.cases.goalEmpty")}
          </p>
        )
      ) : (
        <ul className="-mx-3 flex flex-col">
          {cases.map(({ entry, threadId }) => (
            <CaseRow key={entry.path} entry={entry} threadId={threadId} />
          ))}
        </ul>
      )}
    </section>
  );
}

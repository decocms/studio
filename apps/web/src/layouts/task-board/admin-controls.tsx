/**
 * The board's cross-org controls — everything an admin-org member sees that a
 * normal member does not: a banner naming the org being acted on, an org picker,
 * and the link to the analytics route.
 *
 * Server-gated, not just hidden: `TASK_BOARD_ADMIN_ORG_LIST` returns an empty
 * list to a non-admin, and every endpoint behind these controls refuses one.
 * Picking an org navigates to that org's existing board rather than building a
 * second board that takes an org prop — routing is already the mechanism.
 */

import { useTaskBoardAdminOrgs } from "@/hooks/use-task-board-analytics";
import { useT } from "@/i18n/use-t";
import { Button } from "@decocms/ui/components/button.tsx";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
import { BarChartSquare02 } from "@untitledui/icons";
import { Link, useNavigate, useParams } from "@tanstack/react-router";

export function TaskBoardAdminBanner() {
  const t = useT();
  const org = useParams({ strict: false }).org ?? "";
  const { data } = useTaskBoardAdminOrgs();
  if (!data?.isCrossOrgView) return null;
  return (
    <div className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
      {t("taskBoard.analytics.bannerOrg", { org })}
    </div>
  );
}

export function TaskBoardAdminControls() {
  const t = useT();
  const navigate = useNavigate();
  const org = useParams({ strict: false }).org ?? "";
  const { data } = useTaskBoardAdminOrgs();

  if (!data?.isTaskBoardAdmin) return null;

  const options = data.orgs.map((o) => ({
    value: o.slug,
    label: `${o.slug} · ${o.name}`,
  }));

  return (
    <>
      <Combobox
        options={options}
        value={org}
        onChange={(slug) =>
          navigate({ to: "/$org/tasks/{-$taskKey}", params: { org: slug } })
        }
        width="w-[200px]"
        placeholder={t("taskBoard.analytics.orgPickerPlaceholder")}
        searchPlaceholder={t("taskBoard.analytics.orgSearch")}
        emptyMessage={t("taskBoard.analytics.orgEmpty")}
      />
      <Button size="sm" variant="outline" asChild>
        <Link to="/$org/taskboard-analytics" params={{ org }}>
          <BarChartSquare02 size={16} />
          {t("taskBoard.analytics.openAnalytics")}
        </Link>
      </Button>
    </>
  );
}

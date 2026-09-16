/**
 * The board's cross-org controls — everything an admin-org member sees while
 * standing IN an admin org: a picker for whose board to show, a banner naming
 * it, and the link to the analytics route.
 *
 * Server-gated, not just hidden: `TASK_BOARD_ADMIN_ORG_LIST` answers
 * `isTaskBoardAdmin: false` outside an admin org and for non-members, and every
 * endpoint behind these controls refuses one.
 *
 * Picking writes `?boardOrg=` and stays put — you keep your own org, its
 * sidebar and its chat, and only the board looks elsewhere. See `board-org.tsx`.
 */

import { useTaskBoardAdminOrgs } from "@/hooks/use-task-board-analytics";
import { useT } from "@/i18n/use-t";
import { Button } from "@decocms/ui/components/button.tsx";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
import { BarChartSquare02 } from "@untitledui/icons";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useBoardOrgSlug, useBoardOrgTarget } from "./board-org";

export function TaskBoardAdminBanner() {
  const t = useT();
  // Validated target — must match what BoardOrgProvider actually applies.
  const target = useBoardOrgTarget();
  if (!target) return null;
  return (
    <div className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
      {t("taskBoard.analytics.bannerOrg", { org: target.slug })}
    </div>
  );
}

export function TaskBoardAdminControls() {
  const t = useT();
  const navigate = useNavigate();
  const pathOrg = useParams({ strict: false }).org ?? "";
  const viewing = useBoardOrgSlug();
  const { data } = useTaskBoardAdminOrgs();

  if (!data?.isTaskBoardAdmin) return null;

  const options = [
    { value: pathOrg, label: t("taskBoard.analytics.orgCurrent") },
    ...data.orgs
      .filter((o) => o.slug !== pathOrg)
      .map((o) => ({ value: o.slug, label: `${o.slug} · ${o.name}` })),
  ];

  return (
    <>
      <Combobox
        options={options}
        value={viewing ?? pathOrg}
        onChange={(slug) =>
          navigate({
            to: ".",
            search: (prev: Record<string, unknown>) => ({
              ...prev,
              // Own org drops out of the URL rather than pinning a no-op.
              boardOrg: slug === pathOrg ? undefined : slug,
            }),
            replace: true,
          })
        }
        width="w-[200px]"
        placeholder={t("taskBoard.analytics.orgPickerPlaceholder")}
        searchPlaceholder={t("taskBoard.analytics.orgSearch")}
        emptyMessage={t("taskBoard.analytics.orgEmpty")}
      />
      <Button size="sm" variant="outline" asChild>
        <Link to="/$org/taskboard-analytics" params={{ org: pathOrg }}>
          <BarChartSquare02 size={16} />
          {t("taskBoard.analytics.openAnalytics")}
        </Link>
      </Button>
    </>
  );
}

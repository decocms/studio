/**
 * The board's cross-org controls for admin-org members, plus its analytics link.
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
import { useBoardOrgSlug } from "./board-org";

export function TaskBoardAdminBanner() {
  const t = useT();
  const viewing = useBoardOrgSlug();
  if (!viewing) return null;
  return (
    <div className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
      {t("taskBoard.analytics.bannerBoard", { org: viewing })}
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
  );
}

/** Every board's way into its analytics — a project's board into that
 *  project's, the org board into the org's. */
export function TaskBoardAnalyticsButton({
  project,
}: {
  project: string | null;
}) {
  const t = useT();
  const params = useParams({ strict: false });
  const org = params.org ?? "";
  // `/projects?project=` carries Analytics in its own Project/Files toggle.
  if (project && !params.agentId) return null;
  return (
    <Button size="sm" variant="secondary" asChild>
      {project ? (
        <Link
          to="/$org/projects/$agentId/taskboard-analytics"
          params={{ org, agentId: project }}
        >
          <BarChartSquare02 size={16} />
          {t("taskBoard.analytics.openAnalytics")}
        </Link>
      ) : (
        <Link to="/$org/taskboard-analytics" params={{ org }}>
          <BarChartSquare02 size={16} />
          {t("taskBoard.analytics.openAnalytics")}
        </Link>
      )}
    </Button>
  );
}

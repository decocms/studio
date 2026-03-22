/**
 * Dashboard View Route
 *
 * Full-page view for a single monitoring dashboard.
 */

import { useParams } from "@tanstack/react-router";
import { DashboardViewPage } from "@/web/components/monitoring/dashboard-view";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";

export default function DashboardViewRoute() {
  const { dashboardId } = useParams({
    from: "/shell/$org/monitoring/dashboards/$dashboardId",
  });
  const { org } = useProjectContext();
  const navigate = useNavigate();

  const handleEdit = () => {
    navigate({
      to: "/$org/monitoring/dashboards/$dashboardId/edit",
      params: { org: org.slug, dashboardId },
    });
  };

  return <DashboardViewPage dashboardId={dashboardId} onEdit={handleEdit} />;
}

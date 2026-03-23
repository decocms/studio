/**
 * Dashboards Tab Component
 *
 * Displays saved monitoring dashboards with JSONPath aggregations.
 */

import { ErrorBoundary } from "@/web/components/error-boundary";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { KEYS } from "@/web/lib/query-keys";
import {
  useMCPClient,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import {
  Plus,
  BarChart07,
  Trash01,
  Edit05,
  DotsVertical,
} from "@untitledui/icons";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

// ============================================================================
// Types
// ============================================================================

interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  widgets: Array<{
    id: string;
    name: string;
    type: "metric" | "timeseries" | "table";
  }>;
  createdAt: string;
}

interface DashboardListResponse {
  dashboards: Dashboard[];
  total: number;
}

// ============================================================================
// Dashboard List Content
// ============================================================================

function DashboardListContent() {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const [deleteDialogId, setDeleteDialogId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const { data } = useSuspenseQuery({
    queryKey: KEYS.monitoringDashboards(locator),
    queryFn: async () => {
      if (!client) {
        throw new Error("MCP client is not available");
      }
      const result = (await client.callTool({
        name: "MONITORING_DASHBOARD_LIST",
        arguments: {},
      })) as { structuredContent?: DashboardListResponse };
      return (result.structuredContent ?? result) as DashboardListResponse;
    },
  });

  const dashboards = data?.dashboards ?? [];

  const handleCreate = async () => {
    if (!client) return;
    setIsCreating(true);

    try {
      // Create empty dashboard
      const result = (await client.callTool({
        name: "MONITORING_DASHBOARD_CREATE",
        arguments: {
          name: "Untitled Dashboard",
          widgets: [
            {
              id: crypto.randomUUID(),
              name: "New Widget",
              type: "metric",
              source: { path: "$.usage.total_tokens", from: "output" },
              aggregation: { fn: "sum" },
            },
          ],
        },
      })) as { structuredContent?: { id: string } };

      const dashboardId = (
        result.structuredContent ?? (result as unknown as { id: string })
      ).id;

      queryClient.invalidateQueries({
        queryKey: KEYS.monitoringDashboards(locator),
      });

      // Navigate to edit page
      navigate({
        to: "/$org/monitoring/dashboards/$dashboardId/edit",
        params: { org: org.slug, dashboardId },
      });
    } catch (error) {
      toast.error("Failed to create dashboard");
      console.error(error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleView = (dashboardId: string) => {
    navigate({
      to: "/$org/monitoring/dashboards/$dashboardId",
      params: { org: org.slug, dashboardId },
    });
  };

  const handleEdit = (dashboardId: string) => {
    navigate({
      to: "/$org/monitoring/dashboards/$dashboardId/edit",
      params: { org: org.slug, dashboardId },
    });
  };

  const handleDelete = async (id: string) => {
    if (!client) return;
    setIsDeleting(true);
    try {
      await client.callTool({
        name: "MONITORING_DASHBOARD_DELETE",
        arguments: { id },
      });
      toast.success("Dashboard deleted");
      queryClient.invalidateQueries({
        queryKey: KEYS.monitoringDashboards(locator),
      });
    } catch (error) {
      toast.error("Failed to delete dashboard");
      console.error(error);
    } finally {
      setIsDeleting(false);
      setDeleteDialogId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-auto p-5">
      {/* Dashboard Grid */}
      {dashboards.length === 0 ? (
        <EmptyState
          title="No dashboards yet"
          description="Create a dashboard to aggregate and visualize your monitoring data"
          image={<BarChart07 size={48} className="text-muted-foreground/50" />}
          actions={
            <Button onClick={handleCreate} size="sm" disabled={isCreating}>
              <Plus size={16} className="mr-1.5" />
              Create Dashboard
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {dashboards.map((dashboard) => (
            <ConnectionCard
              key={dashboard.id}
              connection={{
                id: dashboard.id,
                title: dashboard.name,
                description: dashboard.description,
              }}
              fallbackIcon={<BarChart07 />}
              onClick={() => handleView(dashboard.id)}
              headerActions={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DotsVertical size={20} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DropdownMenuItem onClick={() => handleEdit(dashboard.id)}>
                      <Edit05 size={16} />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setDeleteDialogId(dashboard.id)}
                      className="text-destructive"
                    >
                      <Trash01 size={16} />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
              footer={
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {dashboard.widgets.length} widget
                    {dashboard.widgets.length !== 1 ? "s" : ""}
                  </span>
                  <span>·</span>
                  <span>
                    {new Date(dashboard.createdAt).toLocaleDateString()}
                  </span>
                </div>
              }
            />
          ))}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteDialogId}
        onOpenChange={() => setDeleteDialogId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Dashboard</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this dashboard? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={() => deleteDialogId && handleDelete(deleteDialogId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================================
// Skeleton
// ============================================================================

function DashboardsTabSkeleton() {
  return (
    <div className="flex-1 flex flex-col overflow-auto p-5">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="h-6 w-40 bg-muted rounded animate-pulse" />
          <div className="h-4 w-64 bg-muted rounded animate-pulse mt-2" />
        </div>
        <div className="h-8 w-32 bg-muted rounded animate-pulse" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="border rounded-lg p-4">
            <div className="h-5 w-32 bg-muted rounded animate-pulse mb-2" />
            <div className="h-4 w-full bg-muted rounded animate-pulse mb-3" />
            <div className="h-3 w-24 bg-muted rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Export
// ============================================================================

export function DashboardsTab() {
  return (
    <ErrorBoundary
      fallback={
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Failed to load dashboards
        </div>
      }
    >
      <Suspense fallback={<DashboardsTabSkeleton />}>
        <DashboardListContent />
      </Suspense>
    </ErrorBoundary>
  );
}

import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { Page } from "@/web/components/page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { useListState } from "@/web/hooks/use-list-state";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import {
  isDecopilot,
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
  useVirtualMCPs,
  useVirtualMCPActions,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
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
import { Button } from "@deco/ui/components/button.tsx";
import { type TableColumn } from "@/web/components/collections/collection-table.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  DotsVertical,
  Eye,
  Trash01,
  Loading01,
  Users03,
} from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Suspense, useReducer } from "react";
import { User } from "@/web/components/user/user.tsx";
import { AgentConnectionsPreview } from "@/web/components/connections/agent-connections-preview.tsx";
import { formatTimeAgo } from "@/web/lib/format-time";

type DialogState =
  | { mode: "idle" }
  | { mode: "deleting"; virtualMcp: VirtualMCPEntity };

type DialogAction =
  | { type: "delete"; virtualMcp: VirtualMCPEntity }
  | { type: "close" };

function dialogReducer(_state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "delete":
      return { mode: "deleting", virtualMcp: action.virtualMcp };
    case "close":
      return { mode: "idle" };
  }
}

function OrgAgentsContent() {
  const { org } = useProjectContext();
  const navigate = useNavigate();

  // Consolidated list UI state (search, filters, sorting, view mode)
  const listState = useListState<VirtualMCPEntity>({
    namespace: org.slug,
    resource: "agents",
  });

  const virtualMcps = useVirtualMCPs(listState);
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const actions = useVirtualMCPActions();

  const [dialogState, dispatch] = useReducer(dialogReducer, { mode: "idle" });

  const confirmDelete = async () => {
    if (dialogState.mode !== "deleting") return;

    const id = dialogState.virtualMcp.id;
    dispatch({ type: "close" });

    if (!id || isDecopilot(id)) return; // Can't delete Decopilot

    try {
      await actions.delete.mutateAsync(id);
    } catch {
      // Error toast is handled by the mutation's onError
    }
  };

  const columns: TableColumn<VirtualMCPEntity>[] = [
    {
      id: "title",
      header: "Name",
      render: (virtualMcp) => (
        <div className="flex items-center gap-2 min-w-0">
          <IntegrationIcon
            icon={virtualMcp.icon}
            name={virtualMcp.title}
            size="sm"
            className="shrink-0 shadow-sm"
            fallbackIcon={<Users03 size={16} />}
          />
          <span className="text-sm font-medium text-foreground truncate">
            {virtualMcp.title}
          </span>
        </div>
      ),
      cellClassName: "w-48 min-w-0 shrink-0",
      sortable: true,
    },
    {
      id: "description",
      header: "Description",
      render: (virtualMcp) => (
        <span className="text-sm text-foreground line-clamp-2">
          {virtualMcp.description || "—"}
        </span>
      ),
      cellClassName: "flex-1 min-w-0",
      wrap: true,
      sortable: true,
    },
    {
      id: "connections",
      header: "Connections",
      render: (virtualMcp) => (
        <Suspense fallback={<AgentConnectionsPreview.Fallback />}>
          <AgentConnectionsPreview
            connectionIds={virtualMcp.connections.map((c) => c.connection_id)}
            maxVisibleIcons={2}
          />
        </Suspense>
      ),
      cellClassName: "w-28 shrink-0",
    },
    {
      id: "updated_by",
      header: "Updated by",
      render: (virtualMcp) => (
        <User id={virtualMcp.updated_by ?? virtualMcp.created_by} size="3xs" />
      ),
      cellClassName: "w-32 shrink-0",
      sortable: true,
    },
    {
      id: "updated_at",
      header: "Updated",
      render: (virtualMcp) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {virtualMcp.updated_at
            ? formatTimeAgo(new Date(virtualMcp.updated_at))
            : "—"}
        </span>
      ),
      cellClassName: "max-w-24 w-24 shrink-0",
      sortable: true,
    },
    {
      id: "actions",
      header: "",
      render: (virtualMcp) => (
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
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                navigate({
                  to: "/$org/$project/agents/$agentId",
                  params: {
                    org: org.slug,
                    project: ORG_ADMIN_PROJECT_SLUG,
                    agentId: virtualMcp.id,
                  },
                });
              }}
            >
              <Eye size={16} />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "delete", virtualMcp });
              }}
            >
              <Trash01 size={16} />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      cellClassName: "w-12 shrink-0",
    },
  ];

  const ctaButton = (
    <Button
      onClick={createVirtualMCP}
      size="sm"
      className="h-7 px-3 rounded-lg text-sm font-medium"
      disabled={isCreating}
    >
      {isCreating ? "Creating..." : "Create Agent"}
    </Button>
  );

  return (
    <Page>
      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={dialogState.mode === "deleting"}
        onOpenChange={(open) => !open && dispatch({ type: "close" })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {dialogState.mode === "deleting" &&
                  dialogState.virtualMcp.title}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Page Header */}
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Agents</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <CollectionDisplayButton
            viewMode={listState.viewMode}
            onViewModeChange={listState.setViewMode}
            sortKey={listState.sortKey}
            sortDirection={listState.sortDirection}
            onSort={listState.handleSort}
            sortOptions={[
              { id: "title", label: "Name" },
              { id: "description", label: "Description" },
              { id: "updated_by", label: "Updated by" },
              { id: "updated_at", label: "Updated" },
            ]}
          />
          {ctaButton}
        </Page.Header.Right>
      </Page.Header>

      {/* Search Bar */}
      <CollectionSearch
        value={listState.search}
        onChange={listState.setSearch}
        placeholder="Search for an agent..."
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            listState.setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      {/* Content: Cards or Table */}
      <Page.Content>
        {listState.viewMode === "cards" ? (
          <div className="flex-1 overflow-auto p-3 md:p-5">
            {virtualMcps.length === 0 ? (
              <EmptyState
                image={<Users03 size={36} className="text-muted-foreground" />}
                title={listState.search ? "No agents found" : "No agents yet"}
                description={
                  listState.search
                    ? `No agents match "${listState.search}"`
                    : "Create an agent to aggregate tools from multiple Connections."
                }
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {virtualMcps.map((virtualMcp) => (
                  <ConnectionCard
                    key={virtualMcp.id ?? "default"}
                    connection={{
                      id: virtualMcp.id ?? "",
                      title: virtualMcp.title,
                      description: virtualMcp.description,
                      icon: virtualMcp.icon,
                      status: virtualMcp.status,
                    }}
                    fallbackIcon={<Users03 />}
                    onClick={() =>
                      navigate({
                        to: "/$org/$project/agents/$agentId",
                        params: {
                          org: org.slug,
                          project: ORG_ADMIN_PROJECT_SLUG,
                          agentId: virtualMcp.id,
                        },
                      })
                    }
                    footer={
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          {virtualMcp.connections.length} connection
                          {virtualMcp.connections.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    }
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
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate({
                                to: "/$org/$project/agents/$agentId",
                                params: {
                                  org: org.slug,
                                  project: ORG_ADMIN_PROJECT_SLUG,
                                  agentId: virtualMcp.id,
                                },
                              });
                            }}
                          >
                            <Eye size={16} />
                            Open
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              dispatch({ type: "delete", virtualMcp });
                            }}
                          >
                            <Trash01 size={16} />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col overflow-hidden">
            <CollectionTableWrapper
              columns={columns}
              data={virtualMcps}
              isLoading={false}
              sortKey={listState.sortKey}
              sortDirection={listState.sortDirection}
              onSort={listState.handleSort}
              onRowClick={(virtualMcp) =>
                navigate({
                  to: "/$org/$project/agents/$agentId",
                  params: {
                    org: org.slug,
                    project: ORG_ADMIN_PROJECT_SLUG,
                    agentId: virtualMcp.id,
                  },
                })
              }
              emptyState={
                listState.search ? (
                  <EmptyState
                    image={
                      <Users03 size={36} className="text-muted-foreground" />
                    }
                    title="No agents found"
                    description={`No agents match "${listState.search}"`}
                  />
                ) : (
                  <EmptyState
                    image={
                      <Users03 size={36} className="text-muted-foreground" />
                    }
                    title="No agents yet"
                    description="Create an agent to aggregate tools from multiple Connections."
                  />
                )
              }
            />
          </div>
        )}
      </Page.Content>
    </Page>
  );
}

export default function OrgAgents() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <OrgAgentsContent />
      </Suspense>
    </ErrorBoundary>
  );
}

import { useProjectContext } from "@decocms/mesh-sdk";
import {
  type OrganizationRole,
  useOrganizationRoles,
} from "@/web/hooks/use-organization-roles";
import { useOrgAuthClient } from "@/web/hooks/use-org-auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { track } from "@/web/lib/posthog-client";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Plus,
  Lock01,
  DotsVertical,
  Trash01,
  Loading01,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import type { TableColumn } from "@/web/components/collections/collection-table.tsx";
import { Page } from "@/web/components/page";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import {
  RoleDetailPage,
  getTargetKey,
  type RoleEditorTarget,
} from "@/web/views/settings/org-role-detail.tsx";

// ============================================================================
// Role color helpers
// ============================================================================

const BUILTIN_ROLES = [
  { role: "owner", label: "Owner", color: "bg-red-500" },
  { role: "admin", label: "Admin", color: "bg-blue-500" },
  { role: "user", label: "User", color: "bg-green-500" },
] as const;

const ROLE_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-yellow-500",
  "bg-lime-500",
  "bg-green-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-cyan-500",
  "bg-sky-500",
  "bg-blue-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-purple-500",
  "bg-fuchsia-500",
  "bg-pink-500",
  "bg-rose-500",
] as const;

function getRoleColor(roleName: string): string {
  if (!roleName) return "bg-neutral-400";
  let hash = 0;
  for (let i = 0; i < roleName.length; i++) {
    const char = roleName.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const index = Math.abs(hash) % ROLE_COLORS.length;
  return ROLE_COLORS[index] ?? ROLE_COLORS[0];
}

const BUILTIN_ROLE_COLORS: Record<string, string> = {
  owner: "bg-red-500",
  admin: "bg-blue-500",
  user: "bg-green-500",
};

function getRoleDotColor(role: string, isBuiltin: boolean): string {
  if (isBuiltin) return BUILTIN_ROLE_COLORS[role] ?? "bg-neutral-400";
  return getRoleColor(role);
}

// ============================================================================
// Roles Table (main page content)
// ============================================================================

type RoleRow =
  | {
      kind: "builtin";
      role: (typeof BUILTIN_ROLES)[number] & { memberCount: number };
    }
  | { kind: "custom"; role: OrganizationRole & { memberCount: number } };

function RolesPageContent() {
  const [search, setSearch] = useState("");
  const [roleToDelete, setRoleToDelete] = useState<{
    id: string;
    label: string;
  } | null>(null);

  const navigate = useNavigate();
  const { role: roleParam } = useSearch({ strict: false }) as {
    role?: string;
  };

  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const queryClient = useQueryClient();
  const { customRoles, refetch: refetchRoles } = useOrganizationRoles();

  const setActiveRole = (value: string | undefined) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, role: value }),
    });

  const activeTarget: RoleEditorTarget | null = (() => {
    if (!roleParam) return null;
    if (roleParam === "new") return { kind: "new" };
    if (roleParam.startsWith("builtin-")) {
      const slug = roleParam.slice(8) as "owner" | "admin" | "user";
      return { kind: "builtin", role: slug };
    }
    const custom = customRoles.find((r) => r.id === roleParam);
    return custom ? { kind: "custom", role: custom } : null;
  })();
  const { data: membersData } = useQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => orgAuth.organization.listMembers(),
  });

  const members = membersData?.data?.members ?? [];
  type Member = (typeof members)[number];

  const getMemberCount = (roleSlug: string) =>
    members.filter((m: Member) => m.role === roleSlug).length;

  const builtinRows: RoleRow[] = BUILTIN_ROLES.map((r) => ({
    kind: "builtin" as const,
    role: { ...r, memberCount: getMemberCount(r.role) },
  }));

  const customRows: RoleRow[] = customRoles.map((r) => ({
    kind: "custom" as const,
    role: { ...r, memberCount: getMemberCount(r.role) },
  }));

  let allRows: RoleRow[] = [...builtinRows, ...customRows];

  if (search) {
    const q = search.toLowerCase();
    allRows = allRows.filter((row) => row.role.label.toLowerCase().includes(q));
  }

  const deleteRoleMutation = useMutation({
    mutationFn: async (roleId: string) => {
      const result = await orgAuth.organization.deleteRole({ roleId });
      if (result?.error) throw new Error(result.error.message);
      return result?.data;
    },
    onSuccess: (_, roleId) => {
      track("role_deleted", { role_id: roleId });
      queryClient.invalidateQueries({ queryKey: KEYS.members(locator) });
      queryClient.invalidateQueries({
        queryKey: KEYS.organizationRoles(locator),
      });
      toast.success("Role deleted successfully!");
      refetchRoles();
      if (activeTarget?.kind === "custom" && activeTarget.role.id === roleId) {
        setActiveRole(undefined);
      }
    },
    onError: (error, roleId) => {
      track("role_delete_failed", {
        role_id: roleId,
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(
        error instanceof Error ? error.message : "Failed to delete role",
      );
    },
  });

  const columns: TableColumn<RoleRow>[] = [
    {
      id: "role",
      header: "Role",
      render: (row) => (
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "size-2.5 rounded-full shrink-0",
              getRoleDotColor(row.role.role, row.kind === "builtin"),
            )}
          />
          <span className="text-sm font-medium text-foreground truncate">
            {row.role.label}
          </span>
          {row.kind === "builtin" && (
            <Lock01 size={12} className="text-muted-foreground shrink-0" />
          )}
        </div>
      ),
      cellClassName: "flex-1 min-w-0",
      sortable: true,
    },
    {
      id: "type",
      header: "Type",
      render: (row) =>
        row.kind === "builtin" ? (
          <Badge variant="secondary" className="text-xs">
            Built-in
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">
            Custom
          </Badge>
        ),
      cellClassName: "w-28 shrink-0",
    },
    {
      id: "permissions",
      header: "Permissions",
      render: (row) => {
        if (row.kind === "builtin") {
          if (row.role.role === "owner" || row.role.role === "admin") {
            return (
              <span className="text-sm text-muted-foreground">Full access</span>
            );
          }
          return (
            <span className="text-sm text-muted-foreground">Basic access</span>
          );
        }
        const r = row.role as OrganizationRole;
        const parts: string[] = [];
        if (r.allowsAllStaticPermissions) {
          parts.push("Full org access");
        } else if (r.staticPermissionCount && r.staticPermissionCount > 0) {
          parts.push(
            `${r.staticPermissionCount} org perm${r.staticPermissionCount !== 1 ? "s" : ""}`,
          );
        }
        if (r.allowsAllConnections) {
          parts.push("All connections");
        } else if (r.connectionCount && r.connectionCount > 0) {
          parts.push(
            `${r.connectionCount} connection${r.connectionCount !== 1 ? "s" : ""}`,
          );
        }
        return (
          <span className="text-sm text-muted-foreground truncate">
            {parts.length > 0 ? parts.join(", ") : "No permissions"}
          </span>
        );
      },
      cellClassName: "flex-1 min-w-0",
    },
    {
      id: "members",
      header: "Members",
      render: (row) => (
        <span className="text-sm text-foreground">{row.role.memberCount}</span>
      ),
      cellClassName: "w-24 shrink-0",
    },
    {
      id: "actions",
      header: "",
      render: (row) => {
        if (row.kind === "builtin") return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={(e) => e.stopPropagation()}
              >
                <DotsVertical size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  const r = row.role as OrganizationRole;
                  if (r.id) setRoleToDelete({ id: r.id, label: r.label });
                }}
              >
                <Trash01 size={16} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
      cellClassName: "w-12 shrink-0",
    },
  ];

  const handleRowClick = (row: RoleRow) => {
    if (row.kind === "builtin") {
      setActiveRole(`builtin-${row.role.role}`);
    } else {
      const r = row.role as OrganizationRole;
      setActiveRole(r.id);
    }
  };

  if (activeTarget) {
    return (
      <RoleDetailPage
        key={getTargetKey(activeTarget)}
        target={activeTarget}
        onBack={() => setActiveRole(undefined)}
        onSaved={() => {
          refetchRoles();
          setActiveRole(undefined);
        }}
      />
    );
  }

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <Page.Title>Roles</Page.Title>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search roles..."
                className="w-full md:w-[375px]"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("");
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <Button onClick={() => setActiveRole("new")}>
                <Plus size={16} />
                Create Role
              </Button>
            </div>
            <CollectionTableWrapper
              columns={columns}
              data={allRows}
              isLoading={false}
              onRowClick={handleRowClick}
              emptyState={
                search ? (
                  <EmptyState
                    title="No roles found"
                    description={`No roles match "${search}"`}
                  />
                ) : (
                  <EmptyState
                    title="No roles"
                    description="Create a role to get started."
                  />
                )
              }
            />
          </div>
        </Page.Body>
      </Page.Content>

      <AlertDialog
        open={roleToDelete !== null}
        onOpenChange={(open) => !open && setRoleToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Role</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the "{roleToDelete?.label}" role?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (roleToDelete?.id)
                  deleteRoleMutation.mutate(roleToDelete.id);
                setRoleToDelete(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

export default function RolesPage() {
  return (
    <ErrorBoundary
      fallback={
        <Page>
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground">
              Failed to load roles
            </div>
          </div>
        </Page>
      }
    >
      <Suspense
        fallback={
          <Page>
            <div className="flex items-center justify-center h-full">
              <Loading01
                size={32}
                className="animate-spin text-muted-foreground"
              />
            </div>
          </Page>
        }
      >
        <RolesPageContent />
      </Suspense>
    </ErrorBoundary>
  );
}

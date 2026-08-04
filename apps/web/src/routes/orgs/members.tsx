import { CollectionDisplayButton } from "@/components/collections/collection-display-button.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Page } from "@/components/page";
import { CollectionTableWrapper } from "@/components/collections/collection-table-wrapper.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { JoinRequestsSection } from "@/components/settings/join-requests-section";
import { track } from "@/lib/posthog-client";
import { formatDate } from "@/lib/format-time";
import { getInitials } from "@/lib/get-initials";
import { useT } from "@/i18n/use-t.ts";
import { useMembers } from "@/hooks/use-members";
import { useInvitations, useInvitationActions } from "@/hooks/use-invitations";
import { useOrganizationRoles } from "@/hooks/use-organization-roles";
import { useOrgAuthClient } from "@/hooks/use-org-auth-client";
import { getRoleColor, getRoleDotColor } from "@/lib/role-color";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
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
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import type { TableColumn } from "@/components/collections/collection-table.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  DotsVertical,
  SwitchHorizontal01,
  Trash01,
  XClose,
  Shield01,
  Key01,
  Loading01,
} from "@untitledui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { TagMultiSelect } from "@/components/tag-multi-select";

const BUILTIN_ROLES = ["owner", "admin", "user"];

// Create a Map for O(1) role color lookups, reusing the shared role-color palette.
function createRoleColorMap(
  customRoles: Array<{ role: string }>,
): Map<string, string> {
  const colorMap = new Map<string, string>();

  for (const role of BUILTIN_ROLES) {
    colorMap.set(role, getRoleDotColor(role, true));
  }

  for (const role of customRoles) {
    if (role && !colorMap.has(role.role)) {
      colorMap.set(role.role, getRoleColor(role.role));
    }
  }

  return colorMap;
}

interface RoleSelectorProps {
  role: string;
  memberId: string;
  isOwner: boolean;
  roleColorMap: Map<string, string>;
  selectableRoles: Array<{
    role: string;
    label: string;
    isBuiltin: boolean;
  }>;
  onRoleChange: (memberId: string, role: string) => void;
  size?: "xs" | "sm";
  className?: string;
}

function RoleSelector({
  role,
  memberId,
  isOwner,
  roleColorMap,
  selectableRoles,
  onRoleChange,
  size = "xs",
  className,
}: RoleSelectorProps) {
  const t = useT();
  const roleColor = roleColorMap.get(role) ?? "bg-muted-foreground";

  if (isOwner) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="w-fit">
              <Select
                value={role}
                onValueChange={(newRole) => onRoleChange(memberId, newRole)}
                disabled={isOwner}
              >
                <SelectTrigger size={size} className={className}>
                  <SelectValue>
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className={cn(
                          "size-2 rounded-full shrink-0",
                          roleColor,
                        )}
                      />
                      <span className="capitalize truncate">{role}</span>
                    </div>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {selectableRoles.map((r) => {
                    const color =
                      roleColorMap.get(r.role) ?? "bg-muted-foreground";
                    return (
                      <SelectItem key={r.role} value={r.role}>
                        <div className="flex items-center gap-2">
                          <div className={cn("size-3 rounded-full", color)} />
                          <span className="capitalize">{r.label}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("orgs.members.ownerRoleCannotBeChanged")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Select
      value={role}
      onValueChange={(newRole) => onRoleChange(memberId, newRole)}
      disabled={isOwner}
    >
      <SelectTrigger size={size} className={className}>
        <SelectValue>
          <div className="flex items-center gap-2 min-w-0">
            <div className={cn("size-2 rounded-full shrink-0", roleColor)} />
            <span className="capitalize truncate">{role}</span>
          </div>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {selectableRoles.map((r) => {
          const color = roleColorMap.get(r.role) ?? "bg-muted-foreground";
          return (
            <SelectItem key={r.role} value={r.role}>
              <div className="flex items-center gap-2">
                <div className={cn("size-3 rounded-full", color)} />
                <span className="capitalize">{r.label}</span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

interface MemberActionsDropdownProps {
  member: {
    id: string;
    role: string;
  };
  roles: Array<{
    role: string;
    label: string;
    isBuiltin: boolean;
    allowsAllStaticPermissions?: boolean;
    staticPermissionCount?: number;
    allowsAllConnections?: boolean;
    connectionCount?: number;
    allowsAllTools?: boolean;
    toolCount?: number;
  }>;
  onChangeRole: (memberId: string, role: string) => void;
  onRemove: (memberId: string) => void;
  isUpdating?: boolean;
}

function MemberActionsDropdown({
  member,
  roles,
  onChangeRole,
  onRemove,
  isUpdating = false,
}: MemberActionsDropdownProps) {
  const t = useT();
  const isOwner = member.role === "owner";

  // Filter out the current role and owner role from options
  const availableRoles = roles.filter(
    (r) => r.role !== member.role && r.role !== "owner",
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          disabled={isOwner}
          onClick={(e) => e.stopPropagation()}
        >
          <DotsVertical size={20} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={isUpdating}>
            <SwitchHorizontal01 size={16} />
            {t("orgs.members.changeRole")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {availableRoles.map((role) => {
              // Build description parts for custom roles
              const parts: string[] = [];

              if (!role.isBuiltin) {
                // Static permissions
                if (role.allowsAllStaticPermissions) {
                  parts.push(t("orgs.members.fullOrgAccess"));
                } else if (
                  role.staticPermissionCount &&
                  role.staticPermissionCount > 0
                ) {
                  parts.push(
                    t("orgs.members.orgPermsCount", {
                      count: role.staticPermissionCount,
                      plural: role.staticPermissionCount !== 1 ? "s" : "",
                    }),
                  );
                }

                // Connection permissions
                if (role.allowsAllConnections) {
                  parts.push(t("orgs.members.allConnections"));
                } else if (role.connectionCount && role.connectionCount > 0) {
                  parts.push(
                    t("orgs.members.connectionCount", {
                      count: role.connectionCount,
                      plural: role.connectionCount !== 1 ? "s" : "",
                    }),
                  );
                }

                // Tool permissions
                if (role.connectionCount !== 0 || role.allowsAllConnections) {
                  if (role.allowsAllTools) {
                    parts.push(t("orgs.members.allTools"));
                  } else if (role.toolCount && role.toolCount > 0) {
                    parts.push(
                      t("orgs.members.toolCount", {
                        count: role.toolCount,
                        plural: role.toolCount !== 1 ? "s" : "",
                      }),
                    );
                  }
                }
              }

              return (
                <DropdownMenuItem
                  key={role.role}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChangeRole(member.id, role.role);
                  }}
                  disabled={isUpdating}
                >
                  {role.isBuiltin ? (
                    <Shield01 size={16} />
                  ) : (
                    <Key01 size={16} />
                  )}
                  <span className="flex flex-col">
                    <span>{role.label}</span>
                    {!role.isBuiltin && parts.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {parts.join(", ")}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(member.id);
          }}
        >
          <Trash01 size={16} />
          {t("orgs.members.removeMember")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Invitation Actions Dropdown
interface InvitationActionsDropdownProps {
  invitationId: string;
  onCancel: (invitationId: string) => void;
  isCancelling?: boolean;
}

function InvitationActionsDropdown({
  invitationId,
  onCancel,
  isCancelling = false,
}: InvitationActionsDropdownProps) {
  const t = useT();
  return (
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
          variant="destructive"
          onClick={(e) => {
            e.stopPropagation();
            onCancel(invitationId);
          }}
          disabled={isCancelling}
        >
          <XClose size={16} />
          {t("orgs.members.cancelInvitation")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OrgMembersContent() {
  const t = useT();
  const { data } = useMembers();
  const { data: invitations } = useInvitations();
  const invitationActions = useInvitationActions();
  const queryClient = useQueryClient();
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const [memberToRemove, setMemberToRemove] = useState<string | null>(null);
  const [invitationToCancel, setInvitationToCancel] = useState<string | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const [sortKey, setSortKey] = useState<string>("member");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc" | null>(
    "asc",
  );

  const members = data?.data?.members;

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDirection((prev) =>
        prev === "asc" ? "desc" : prev === "desc" ? null : "asc",
      );
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };

  let filteredMembers = members ?? [];
  let filteredInvitations = invitations ?? [];

  // Filter by search
  if (search) {
    const lowerSearch = search.toLowerCase();
    filteredMembers = filteredMembers.filter(
      (member: (typeof filteredMembers)[number]) =>
        member.user?.name?.toLowerCase().includes(lowerSearch) ||
        member.user?.email?.toLowerCase().includes(lowerSearch) ||
        member.role?.toLowerCase().includes(lowerSearch),
    );
    filteredInvitations = filteredInvitations.filter(
      (inv) =>
        inv.email?.toLowerCase().includes(lowerSearch) ||
        inv.role?.toLowerCase().includes(lowerSearch),
    );
  }

  // Sort members
  if (sortKey && sortDirection) {
    filteredMembers = [...filteredMembers].sort((a, b) => {
      let aVal: string;
      let bVal: string;

      switch (sortKey) {
        case "member":
          aVal = a.user?.name || "";
          bVal = b.user?.name || "";
          break;
        case "role":
          aVal = a.role || "";
          bVal = b.role || "";
          break;
        case "joined":
          aVal = a.createdAt
            ? typeof a.createdAt === "string"
              ? a.createdAt
              : a.createdAt.toISOString()
            : "";
          bVal = b.createdAt
            ? typeof b.createdAt === "string"
              ? b.createdAt
              : b.createdAt.toISOString()
            : "";
          break;
        default:
          return 0;
      }

      return sortDirection === "asc"
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    });
  }

  const filteredAndSortedMembers = filteredMembers;

  const removeMemberMutation = useMutation({
    mutationFn: async (memberId: string) => {
      const result = await orgAuth.organization.removeMember({
        memberIdOrEmail: memberId,
      });
      if (result?.error) {
        throw new Error(result.error.message);
      }
    },
    onSuccess: () => {
      track("member_removed");
      queryClient.invalidateQueries({ queryKey: KEYS.members(locator) });
      toast.success(t("orgs.members.memberRemovedSuccess"));
      setMemberToRemove(null);
    },
    onError: (error) => {
      track("member_remove_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(
        error instanceof Error
          ? error.message
          : t("orgs.members.failedRemoveMember"),
      );
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({
      memberId,
      role,
    }: {
      memberId: string;
      role: string;
    }) => {
      const result = await orgAuth.organization.updateMemberRole({
        memberId,
        role: [role],
      });
      if (result?.error) {
        throw new Error(result.error.message);
      }
    },
    onSuccess: (_res, vars) => {
      track("member_role_updated", { new_role: vars.role });
      queryClient.invalidateQueries({ queryKey: KEYS.members(locator) });
      toast.success(t("orgs.members.roleUpdatedSuccess"));
    },
    onError: (error, vars) => {
      track("member_role_update_failed", {
        new_role: vars.role,
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(
        error instanceof Error
          ? error.message
          : t("orgs.members.failedUpdateRole"),
      );
    },
  });

  const updateInvitationRoleMutation = useMutation({
    mutationFn: async ({
      invitationId,
      role,
      email,
    }: {
      invitationId: string;
      role: string;
      email: string;
    }) => {
      // Cancel the old invitation
      const cancelResult = await orgAuth.organization.cancelInvitation({
        invitationId,
      });
      if (cancelResult?.error) {
        throw new Error(cancelResult.error.message);
      }

      // Create new invitation with updated role
      const inviteResult = await orgAuth.organization.inviteMember({
        email,
        role: role as "admin" | "owner",
      });
      if (inviteResult?.error) {
        throw new Error(inviteResult.error.message);
      }
    },
    onSuccess: (_res, vars) => {
      track("invitation_role_updated", { new_role: vars.role });
      queryClient.invalidateQueries({ queryKey: KEYS.invitations(locator) });
      toast.success(t("orgs.members.invitationRoleUpdatedSuccess"));
    },
    onError: (error, vars) => {
      track("invitation_role_update_failed", {
        new_role: vars.role,
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(
        error instanceof Error
          ? error.message
          : t("orgs.members.failedUpdateInvitationRole"),
      );
    },
  });

  const { roles, customRoles } = useOrganizationRoles();

  // Create role color map for O(1) lookups (instead of O(n) findIndex per render)
  // React Compiler will handle memoization automatically
  const roleColorMap = createRoleColorMap(customRoles);

  // Filter selectable roles once (React Compiler will handle memoization)
  const selectableRoles = roles.filter((role) => role.role !== "owner");

  type Member = NonNullable<typeof members>[number];
  type Invitation = (typeof invitations)[number];

  // Unified row type for both members and pending invitations
  type MemberRow =
    | { type: "member"; data: Member }
    | { type: "invitation"; data: Invitation };

  // React Compiler will handle memoization of this columns array
  const columns: TableColumn<MemberRow>[] = [
    {
      id: "member",
      header: t("orgs.members.columnMember"),
      render: (row) => {
        if (row.type === "member") {
          return (
            <div className="flex items-center gap-3">
              <Avatar
                url={row.data.user?.image ?? undefined}
                fallback={getInitials(row.data.user?.name)}
                shape="circle"
                size="sm"
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground truncate">
                  {row.data.user?.name || t("orgs.members.unknown")}
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {row.data.user?.email}
                </div>
              </div>
            </div>
          );
        }
        // Invitation row
        return (
          <div className="flex items-center gap-3">
            <Avatar
              fallback={getInitials(row.data.email)}
              shape="circle"
              size="sm"
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground truncate">
                {row.data.email}
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {t("orgs.members.invitationSent")}
              </div>
            </div>
          </div>
        );
      },
      cellClassName: "flex-1 min-w-0",
      sortable: true,
    },
    {
      id: "role",
      header: t("orgs.members.columnRole"),
      render: (row) => {
        if (row.type === "member") {
          return (
            <RoleSelector
              role={row.data.role}
              memberId={row.data.id}
              isOwner={row.data.role === "owner"}
              roleColorMap={roleColorMap}
              selectableRoles={selectableRoles}
              onRoleChange={(memberId, role) =>
                updateRoleMutation.mutate({ memberId, role })
              }
              className="w-36"
            />
          );
        }
        // Invitation - show role selector
        return (
          <RoleSelector
            role={row.data.role}
            memberId={row.data.id}
            isOwner={false}
            roleColorMap={roleColorMap}
            selectableRoles={selectableRoles}
            onRoleChange={(invitationId, role) =>
              updateInvitationRoleMutation.mutate({
                invitationId,
                role,
                email: row.data.email,
              })
            }
            className="w-36"
          />
        );
      },
      cellClassName: "w-36 shrink-0",
      sortable: true,
    },
    {
      id: "tags",
      header: t("orgs.members.columnTags"),
      render: (row) => {
        if (row.type === "member") {
          return <TagMultiSelect memberId={row.data.id} maxDisplay={2} />;
        }
        // Invitations don't have tags
        return <span className="text-xs text-muted-foreground">-</span>;
      },
      cellClassName: "w-40 shrink-0",
    },
    {
      id: "joined",
      header: t("orgs.members.columnJoined"),
      render: (row) => {
        if (row.type === "member") {
          return (
            <span className="text-sm text-foreground">
              {row.data.createdAt
                ? formatDate(row.data.createdAt)
                : t("orgs.members.na")}
            </span>
          );
        }
        // Invitation - show pending badge
        return <Badge variant="outline">{t("orgs.members.pending")}</Badge>;
      },
      cellClassName: "w-48 shrink-0",
      sortable: true,
    },
    {
      id: "actions",
      header: "",
      render: (row) => {
        if (row.type === "member") {
          return (
            <MemberActionsDropdown
              member={row.data}
              roles={roles}
              onChangeRole={(memberId, role) =>
                updateRoleMutation.mutate({ memberId, role })
              }
              onRemove={setMemberToRemove}
              isUpdating={updateRoleMutation.isPending}
            />
          );
        }
        // Invitation actions
        return (
          <InvitationActionsDropdown
            invitationId={row.data.id}
            onCancel={setInvitationToCancel}
            isCancelling={invitationActions.cancel.isPending}
          />
        );
      },
      cellClassName: "w-12 shrink-0",
    },
  ];

  const ctaButton = (
    <div className="flex items-center gap-2">
      <InviteMemberDialog
        trigger={<Button>{t("orgs.members.inviteMember")}</Button>}
      />
    </div>
  );

  // Build unified rows for table
  const allRows: MemberRow[] = [
    ...filteredAndSortedMembers.map(
      (member: (typeof filteredAndSortedMembers)[number]) => ({
        type: "member" as const,
        data: member,
      }),
    ),
    ...filteredInvitations
      .filter((inv) => inv.status === "pending")
      .map((inv) => ({ type: "invitation" as const, data: inv })),
  ];

  return (
    <Page>
      {/* Cancel Invitation Dialog */}
      <AlertDialog
        open={!!invitationToCancel}
        onOpenChange={() => setInvitationToCancel(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("orgs.members.cancelInvitationTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("orgs.members.cancelInvitationDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("orgs.members.keepInvitation")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (invitationToCancel) {
                  invitationActions.cancel.mutate(invitationToCancel);
                  setInvitationToCancel(null);
                }
              }}
              disabled={invitationActions.cancel.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("orgs.members.cancelInvitation")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!memberToRemove}
        onOpenChange={() => setMemberToRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("orgs.members.removeMemberTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("orgs.members.removeMemberDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("orgs.members.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                memberToRemove && removeMemberMutation.mutate(memberToRemove)
              }
              disabled={removeMemberMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("orgs.members.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <JoinRequestsSection />
            <Page.Title>{t("orgs.members.title")}</Page.Title>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={t("orgs.members.searchPlaceholder")}
                  className="w-full md:w-[375px]"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setSearch("");
                      (event.target as HTMLInputElement).blur();
                    }
                  }}
                />
                <CollectionDisplayButton
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  sortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  sortOptions={[
                    { id: "member", label: t("orgs.members.sortName") },
                    { id: "role", label: t("orgs.members.sortRole") },
                    { id: "joined", label: t("orgs.members.sortJoined") },
                  ]}
                />
              </div>
              {ctaButton}
            </div>
            {viewMode === "cards" ? (
              <div>
                {allRows.length === 0 ? (
                  <EmptyState
                    title={t("orgs.members.noMembersFound")}
                    description={
                      search
                        ? t("orgs.members.noMembersMatch", { search })
                        : t("orgs.members.inviteMembersGetStarted")
                    }
                  />
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                    {allRows.map((row) => {
                      if (row.type === "invitation") {
                        // Invitation card
                        return (
                          <Card
                            key={`inv-${row.data.id}`}
                            className="transition-colors relative opacity-75"
                          >
                            <div className="absolute top-4 right-4 z-10">
                              <InvitationActionsDropdown
                                invitationId={row.data.id}
                                onCancel={setInvitationToCancel}
                                isCancelling={
                                  invitationActions.cancel.isPending
                                }
                              />
                            </div>
                            <div className="flex flex-col gap-4 p-6">
                              <Avatar
                                fallback={getInitials(row.data.email)}
                                shape="circle"
                                size="lg"
                                className="shrink-0"
                              />
                              <div className="flex flex-col gap-2">
                                <h3 className="text-base font-medium text-foreground truncate">
                                  {row.data.email}
                                </h3>
                                <div className="flex items-center gap-2">
                                  <Badge
                                    variant="outline"
                                    className="w-fit text-warning border-warning/40"
                                  >
                                    {t("orgs.members.pending")}
                                  </Badge>
                                </div>
                                <RoleSelector
                                  role={row.data.role}
                                  memberId={row.data.id}
                                  isOwner={false}
                                  roleColorMap={roleColorMap}
                                  selectableRoles={selectableRoles}
                                  onRoleChange={(invitationId, role) =>
                                    updateInvitationRoleMutation.mutate({
                                      invitationId,
                                      role,
                                      email: row.data.email,
                                    })
                                  }
                                  className="w-fit"
                                />
                              </div>
                            </div>
                          </Card>
                        );
                      }
                      // Member card
                      const member = row.data;
                      return (
                        <Card
                          key={member.id}
                          className="transition-colors relative"
                        >
                          <div className="absolute top-4 right-4 z-10">
                            <MemberActionsDropdown
                              member={member}
                              roles={roles}
                              onChangeRole={(memberId, role) =>
                                updateRoleMutation.mutate({ memberId, role })
                              }
                              onRemove={setMemberToRemove}
                              isUpdating={updateRoleMutation.isPending}
                            />
                          </div>
                          <div className="flex flex-col gap-4 p-6">
                            <Avatar
                              url={member.user?.image ?? undefined}
                              fallback={getInitials(member.user?.name)}
                              shape="circle"
                              size="lg"
                              className="shrink-0"
                            />
                            <div className="flex flex-col gap-2">
                              <h3 className="text-base font-medium text-foreground truncate">
                                {member.user?.name || "Unknown"}
                              </h3>
                              <p className="text-sm text-muted-foreground truncate">
                                {member.user?.email}
                              </p>
                              <RoleSelector
                                role={member.role}
                                memberId={member.id}
                                isOwner={member.role === "owner"}
                                roleColorMap={roleColorMap}
                                selectableRoles={selectableRoles}
                                onRoleChange={(memberId, role) =>
                                  updateRoleMutation.mutate({ memberId, role })
                                }
                                className="w-fit"
                              />
                              <TagMultiSelect
                                memberId={member.id}
                                maxDisplay={3}
                              />
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <CollectionTableWrapper
                columns={columns}
                data={allRows}
                isLoading={false}
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSort={handleSort}
                emptyState={
                  search ? (
                    <EmptyState
                      title={t("orgs.members.noMembersFound")}
                      description={t("orgs.members.noMembersMatch", { search })}
                    />
                  ) : (
                    <EmptyState
                      title={t("orgs.members.noMembersFound")}
                      description={t("orgs.members.inviteMembersGetStarted")}
                    />
                  )
                }
              />
            )}
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

export default function OrgMembers() {
  const t = useT();
  return (
    <ErrorBoundary
      fallback={
        <Page>
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground">
              {t("orgs.members.failedLoadMembers")}
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
        <OrgMembersContent />
      </Suspense>
    </ErrorBoundary>
  );
}

import {
  getPermissionOptions,
  getToolsByCategory,
  type ToolName,
} from "@/tools/registry";
import { DEFAULT_LOGO, PROVIDER_LOGOS } from "@/web/utils/ai-providers-logos";
import { ToolSetSelector } from "@/web/components/tool-set-selector.tsx";
import { useMembers } from "@/web/hooks/use-members";
import {
  useOrganizationRoles,
  type OrganizationRole,
} from "@/web/hooks/use-organization-roles";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { useConnections, useProjectContext } from "@decocms/mesh-sdk";
import {
  AiProviderKey,
  useAiProviderKeyList,
  useSuspenseAiProviderModels,
} from "@/web/hooks/collections/use-llm";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
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
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Plus,
  Lock01,
  DotsHorizontal,
  Trash01,
  Loading01,
  X,
} from "@untitledui/icons";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useDeferredValue, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CollectionSearch } from "./collections/collection-search.tsx";

interface ManageRolesDialogProps {
  trigger: React.ReactNode;
  onSuccess?: () => void;
}

// ============================================================================
// Zod Schema - Single role form
// ============================================================================

const roleFormSchema = z.object({
  // Role identity fields
  role: z.object({
    id: z.string().optional(),
    slug: z.string().optional(),
    label: z.string(),
  }),
  // Static permissions (organization-level)
  allowAllStaticPermissions: z.boolean(),
  staticPermissions: z.array(z.string()),
  // Connection-specific permissions (MCP permissions)
  toolSet: z.record(z.string(), z.array(z.string())),
  // Model permissions (connection-scoped)
  allowAllModels: z.boolean(),
  modelSet: z.record(z.string(), z.array(z.string())),
  // Members
  memberIds: z.array(z.string()),
});

type RoleFormData = z.infer<typeof roleFormSchema>;

// Helper to get initials from name
function getInitials(name: string | undefined | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// Built-in roles that cannot be edited
const BUILTIN_ROLES = [
  { role: "owner", label: "Owner", color: "bg-red-500" },
  { role: "admin", label: "Admin", color: "bg-blue-500" },
  { role: "user", label: "User", color: "bg-green-500" },
] as const;

// Available colors for custom roles
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

// Deterministic color based on role name using simple hash
function getRoleColor(roleName: string): string {
  if (!roleName) return "bg-neutral-400";
  let hash = 0;
  for (let i = 0; i < roleName.length; i++) {
    const char = roleName.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  const index = Math.abs(hash) % ROLE_COLORS.length;
  return ROLE_COLORS[index] ?? ROLE_COLORS[0];
}

// Create empty role
function createEmptyRole(): RoleFormData {
  return {
    role: {
      id: undefined,
      slug: undefined,
      label: "",
    },
    allowAllStaticPermissions: false,
    staticPermissions: [],
    toolSet: {},
    allowAllModels: true,
    modelSet: {},
    memberIds: [],
  };
}

// ============================================================================
// Organization Permissions Tab
// ============================================================================

interface OrgPermissionsTabProps {
  allowAllStaticPermissions: boolean;
  staticPermissions: string[];
  onAllowAllChange: (allowAll: boolean) => void;
  onPermissionsChange: (permissions: string[]) => void;
  readOnly?: boolean;
}

function OrgPermissionsTab({
  allowAllStaticPermissions,
  staticPermissions,
  onAllowAllChange,
  onPermissionsChange,
  readOnly = false,
}: OrgPermissionsTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const toolsByCategory = getToolsByCategory();
  const allPermissions = getPermissionOptions();

  // Filter permissions by search
  const filteredPermissions = allPermissions.filter((perm) =>
    perm.label.toLowerCase().includes(deferredSearchQuery.toLowerCase()),
  );

  // Toggle a single permission
  const togglePermission = (permission: ToolName) => {
    if (staticPermissions.includes(permission)) {
      onPermissionsChange(staticPermissions.filter((p) => p !== permission));
    } else {
      const newPermissions = [...staticPermissions, permission];
      // If all permissions are now selected, turn on allowAll
      if (newPermissions.length === allPermissions.length) {
        onAllowAllChange(true);
        onPermissionsChange([]);
      } else {
        onPermissionsChange(newPermissions);
      }
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="border-b border-border">
        <CollectionSearch
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search permissions..."
          className="border-b-0"
        />
      </div>

      {/* Select All Toggle */}
      <div className="border-b border-border">
        <div
          className={cn(
            "flex items-center justify-between px-4 py-3 rounded-lg",
            !readOnly && "hover:bg-muted/50 cursor-pointer",
          )}
          onClick={() => {
            if (readOnly) return;
            const newValue = !allowAllStaticPermissions;
            onAllowAllChange(newValue);
            onPermissionsChange([]);
          }}
        >
          <span className="text-sm font-medium">
            All organization permissions
          </span>
          <div onClick={(e) => e.stopPropagation()}>
            {readOnly ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Switch
                        checked={allowAllStaticPermissions}
                        disabled={readOnly}
                        onCheckedChange={(checked) => {
                          if (readOnly) return;
                          onAllowAllChange(checked);
                          onPermissionsChange([]);
                        }}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Built-in role permissions cannot be changed</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <Switch
                checked={allowAllStaticPermissions}
                disabled={readOnly}
                onCheckedChange={(checked) => {
                  if (readOnly) return;
                  onAllowAllChange(checked);
                  onPermissionsChange([]);
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Permissions List */}
      <div className="flex-1 overflow-auto">
        {Object.entries(toolsByCategory).map(([category, tools]) => {
          const categoryPermissions = filteredPermissions.filter((p) =>
            tools.some((t) => t.name === p.value),
          );

          if (categoryPermissions.length === 0) return null;

          return (
            <div key={category} className="mb-6 last:mb-0">
              <h4 className="text-sm font-medium p-3 pb-1.5 text-muted-foreground/75">
                {category}
              </h4>
              <div className="space-y-1">
                {categoryPermissions.map((permission) => (
                  <div
                    key={permission.value}
                    className={cn(
                      "flex items-center justify-between gap-3 px-4 py-3",
                      !readOnly && "hover:bg-muted/50 cursor-pointer",
                    )}
                    onClick={() => {
                      if (readOnly) return;
                      if (allowAllStaticPermissions) {
                        onAllowAllChange(false);
                        // Select all except this one
                        const allPerms = allPermissions.map((p) => p.value);
                        onPermissionsChange(
                          allPerms.filter((p) => p !== permission.value),
                        );
                      } else {
                        togglePermission(permission.value);
                      }
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm">{permission.label}</span>
                    </div>
                    <div onClick={(e) => e.stopPropagation()}>
                      {readOnly ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div>
                                <Switch
                                  checked={
                                    allowAllStaticPermissions ||
                                    staticPermissions.includes(permission.value)
                                  }
                                  disabled={readOnly}
                                  onCheckedChange={() => {
                                    if (readOnly) return;
                                    if (allowAllStaticPermissions) {
                                      onAllowAllChange(false);
                                      // Select all except this one
                                      const allPerms = allPermissions.map(
                                        (p) => p.value,
                                      );
                                      onPermissionsChange(
                                        allPerms.filter(
                                          (p) => p !== permission.value,
                                        ),
                                      );
                                    } else {
                                      togglePermission(permission.value);
                                    }
                                  }}
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Built-in role permissions cannot be changed</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <Switch
                          checked={
                            allowAllStaticPermissions ||
                            staticPermissions.includes(permission.value)
                          }
                          disabled={readOnly}
                          onCheckedChange={() => {
                            if (readOnly) return;
                            if (allowAllStaticPermissions) {
                              onAllowAllChange(false);
                              // Select all except this one
                              const allPerms = allPermissions.map(
                                (p) => p.value,
                              );
                              onPermissionsChange(
                                allPerms.filter((p) => p !== permission.value),
                              );
                            } else {
                              togglePermission(permission.value);
                            }
                          }}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Models Permissions Tab
// ============================================================================

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

interface ModelsPermissionsTabProps {
  allowAllModels: boolean;
  modelSet: Record<string, string[]>;
  onAllowAllChange: (allowAll: boolean) => void;
  onModelSetChange: (modelSet: Record<string, string[]>) => void;
  readOnly?: boolean;
}

/**
 * Inner component per connection that fetches and displays models.
 * Wrapped in Suspense by the parent.
 */
const MODELS_PAGE_SIZE = 30;

function ConnectionModelsSection({
  connection,
  selectedModels,
  allowAllModels,
  onToggleModel,
  onToggleConnectionAll,
  allConnectionModelsSelected,
  searchQuery,
  readOnly,
}: {
  connection: AiProviderKey;
  selectedModels: string[];
  allowAllModels: boolean;
  onToggleModel: (keyId: string, modelId: string) => void;
  onToggleConnectionAll: (keyId: string, models: { id: string }[]) => void;
  allConnectionModelsSelected: boolean;
  searchQuery: string;
  readOnly: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(MODELS_PAGE_SIZE);
  const rawModels = useSuspenseAiProviderModels(connection.id);
  const models = rawModels
    .filter((m, i, arr) => arr.findIndex((x) => x.modelId === m.modelId) === i)
    .map((m) => ({
      ...m,
      id: m.modelId,
      provider: connection.label,
    }));

  // Filter models by search query
  const filteredModels = searchQuery.trim()
    ? models.filter(
        (m) =>
          m.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.provider?.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : models;

  if (filteredModels.length === 0) return null;

  const visibleModels = filteredModels.slice(0, visibleCount);
  const hasMore = filteredModels.length > visibleCount;

  // Check if all filtered models in this connection are selected
  const allSelected =
    allowAllModels ||
    allConnectionModelsSelected ||
    (selectedModels.includes("*") && !allowAllModels) ||
    filteredModels.every(
      (m) => selectedModels.includes(m.id) || selectedModels.includes("*"),
    );

  return (
    <div className="mb-6 last:mb-0">
      {/* Connection header with toggle-all for this connection */}
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <img
            src={PROVIDER_LOGOS[connection.providerId] ?? DEFAULT_LOGO}
            alt={connection.providerId}
            className="w-4 h-4 rounded-sm"
          />
          <div className="flex flex-col">
            <h4 className="text-sm font-medium text-muted-foreground/75">
              {PROVIDER_DISPLAY_NAMES[connection.providerId] ??
                connection.providerId}
            </h4>
            <span className="text-xs text-muted-foreground/50">
              {connection.label}
            </span>
          </div>
        </div>
        {!readOnly && !allowAllModels && (
          <Switch
            checked={allSelected}
            onCheckedChange={() => onToggleConnectionAll(connection.id, models)}
          />
        )}
      </div>
      {/* Model list */}
      <div className="space-y-1">
        {visibleModels.map((model) => {
          const isEnabled =
            allowAllModels ||
            selectedModels.includes("*") ||
            selectedModels.includes(model.id);

          return (
            <div
              key={model.id}
              className={cn(
                "flex items-center justify-between gap-3 px-4 py-3",
                !readOnly && "hover:bg-muted/50 cursor-pointer",
              )}
              onClick={() => {
                if (readOnly || allowAllModels) return;
                onToggleModel(connection.id, model.id);
              }}
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {model.logo && (
                  <img
                    src={model.logo}
                    className="w-4 h-4 shrink-0 rounded-sm"
                    alt={model.title}
                  />
                )}
                <span className="text-sm truncate">{model.title}</span>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                {readOnly ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <Switch checked={isEnabled} disabled />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Built-in role permissions cannot be changed</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Switch
                    checked={isEnabled}
                    disabled={readOnly || allowAllModels}
                    onCheckedChange={() => {
                      if (readOnly || allowAllModels) return;
                      onToggleModel(connection.id, model.id);
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
        {hasMore && (
          <button
            type="button"
            className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            onClick={() => setVisibleCount((c) => c + MODELS_PAGE_SIZE)}
          >
            Show more ({filteredModels.length - visibleCount} remaining)
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectionModelsSectionFallback() {
  return (
    <div className="px-4 py-3 flex items-center gap-2 text-sm text-muted-foreground">
      <Loading01 className="size-4 animate-spin" />
      Loading models...
    </div>
  );
}

function ModelsPermissionsTab({
  allowAllModels,
  modelSet,
  onAllowAllChange,
  onModelSetChange,
  readOnly = false,
}: ModelsPermissionsTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const allModelsConnections = useAiProviderKeyList();

  // Toggle a single model for a connection
  const toggleModel = (connectionId: string, modelId: string) => {
    const current = modelSet[connectionId] ?? [];
    const newModelSet = { ...modelSet };
    if (current.includes(modelId)) {
      const filtered = current.filter((m) => m !== modelId);
      if (filtered.length === 0) {
        delete newModelSet[connectionId];
      } else {
        newModelSet[connectionId] = filtered;
      }
    } else {
      newModelSet[connectionId] = [...current, modelId];
    }
    onModelSetChange(newModelSet);
  };

  // Toggle all models for a connection
  const toggleConnectionAll = (
    connectionId: string,
    models: { id: string }[],
  ) => {
    const current = modelSet[connectionId] ?? [];
    const allModelIds = models.map((m) => m.id);
    const allSelected =
      current.includes("*") || allModelIds.every((id) => current.includes(id));

    const newModelSet = { ...modelSet };
    if (allSelected) {
      // Deselect all for this connection
      delete newModelSet[connectionId];
    } else {
      // Select all for this connection
      newModelSet[connectionId] = allModelIds;
    }
    onModelSetChange(newModelSet);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="border-b border-border">
        <CollectionSearch
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search models..."
          className="border-b-0"
        />
      </div>

      {/* Select All Toggle */}
      <div className="border-b border-border">
        <div
          className={cn(
            "flex items-center justify-between px-4 py-3 rounded-lg",
            !readOnly && "hover:bg-muted/50 cursor-pointer",
          )}
          onClick={() => {
            if (readOnly) return;
            const newValue = !allowAllModels;
            onAllowAllChange(newValue);
            if (newValue) {
              onModelSetChange({});
            }
          }}
        >
          <span className="text-sm font-medium">All models</span>
          <div onClick={(e) => e.stopPropagation()}>
            {readOnly ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Switch checked={allowAllModels} disabled />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Built-in role permissions cannot be changed</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <Switch
                checked={allowAllModels}
                onCheckedChange={(checked) => {
                  if (readOnly) return;
                  onAllowAllChange(checked);
                  if (checked) {
                    onModelSetChange({});
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Models list grouped by connection */}
      <div className="flex-1 overflow-auto">
        {allModelsConnections.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            No LLM connections configured
          </div>
        ) : (
          allModelsConnections.map((conn) => (
            <Suspense
              key={conn.id}
              fallback={<ConnectionModelsSectionFallback />}
            >
              <ConnectionModelsSection
                connection={conn}
                selectedModels={modelSet[conn.id] ?? []}
                allowAllModels={allowAllModels}
                onToggleModel={toggleModel}
                onToggleConnectionAll={toggleConnectionAll}
                allConnectionModelsSelected={(modelSet[conn.id] ?? []).includes(
                  "*",
                )}
                searchQuery={deferredSearchQuery}
                readOnly={readOnly}
              />
            </Suspense>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Add Member Dialog
// ============================================================================

interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedMemberIds: string[];
  onAddMembers: (memberIds: string[]) => void;
}

function AddMemberDialog({
  open,
  onOpenChange,
  selectedMemberIds,
  onAddMembers,
}: AddMemberDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [pendingMemberIds, setPendingMemberIds] = useState<string[]>([]);

  const { data } = useMembers();
  const members = data?.data?.members ?? [];

  // Filter members by search
  const filteredMembers = members.filter((member) => {
    const searchLower = deferredSearchQuery.toLowerCase();
    return (
      member.user?.name?.toLowerCase().includes(searchLower) ||
      member.user?.email?.toLowerCase().includes(searchLower)
    );
  });

  // Check if member is eligible (not owner)
  const isMemberEligible = (member: (typeof members)[number]) => {
    return member.role !== "owner";
  };

  // Check if member is already in the role
  const isAlreadyInRole = (memberId: string) => {
    return selectedMemberIds.includes(memberId);
  };

  // Toggle member selection
  const toggleMember = (memberId: string) => {
    if (pendingMemberIds.includes(memberId)) {
      setPendingMemberIds(pendingMemberIds.filter((id) => id !== memberId));
    } else {
      setPendingMemberIds([...pendingMemberIds, memberId]);
    }
  };

  const handleAdd = () => {
    onAddMembers(pendingMemberIds);
    setPendingMemberIds([]);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md p-0 overflow-hidden">
        <AlertDialogHeader className="px-6 pt-6">
          <AlertDialogTitle>Add Members to Role</AlertDialogTitle>
          <AlertDialogDescription>
            Select members to add to this role.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col h-80">
          <CollectionSearch
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search members..."
            className="border-b border-t-0 border-x-0 rounded-none"
          />

          <div className="flex-1 overflow-auto">
            {filteredMembers.length === 0 ? (
              <div className="flex items-center justify-center h-full px-6">
                <p className="text-sm text-muted-foreground">
                  {searchQuery ? "No members found" : "No members available"}
                </p>
              </div>
            ) : (
              <div className="px-6 py-2 space-y-1">
                {filteredMembers.map((member) => {
                  const eligible = isMemberEligible(member);
                  const alreadyInRole = isAlreadyInRole(member.id);
                  const isSelected = pendingMemberIds.includes(member.id);

                  return (
                    <label
                      key={member.id}
                      className={cn(
                        "flex items-center gap-3 p-2 rounded-lg",
                        !eligible || alreadyInRole
                          ? "opacity-50 cursor-not-allowed"
                          : "cursor-pointer hover:bg-muted/50",
                      )}
                    >
                      <Checkbox
                        checked={isSelected || alreadyInRole}
                        onCheckedChange={() => {
                          if (eligible && !alreadyInRole) {
                            toggleMember(member.id);
                          }
                        }}
                        disabled={!eligible || alreadyInRole}
                      />
                      <Avatar
                        url={member.user?.image ?? undefined}
                        fallback={getInitials(member.user?.name)}
                        shape="circle"
                        size="sm"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {member.user?.name || "Unknown"}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {member.user?.email}
                        </p>
                      </div>
                      {!eligible && (
                        <Badge variant="secondary" className="shrink-0">
                          Owner
                        </Badge>
                      )}
                      {alreadyInRole && eligible && (
                        <Badge variant="outline" className="shrink-0">
                          Added
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <AlertDialogFooter className="px-6 pb-6">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleAdd}
            disabled={pendingMemberIds.length === 0}
          >
            Add {pendingMemberIds.length > 0 && `(${pendingMemberIds.length})`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ============================================================================
// Members Tab
// ============================================================================

interface MembersTabProps {
  memberIds: string[];
  onMemberIdsChange: (memberIds: string[]) => void;
  readOnly?: boolean;
}

function MembersTabContent({
  memberIds,
  onMemberIdsChange,
  readOnly = false,
}: MembersTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);

  const { data } = useMembers();
  const members = data?.data?.members ?? [];

  // Get members that are in this role
  const roleMembers = members.filter((m) => memberIds.includes(m.id));

  // Filter by search
  const filteredMembers = roleMembers.filter((member) => {
    const searchLower = deferredSearchQuery.toLowerCase();
    return (
      member.user?.name?.toLowerCase().includes(searchLower) ||
      member.user?.email?.toLowerCase().includes(searchLower)
    );
  });

  // Remove member from role
  const removeMember = (memberId: string) => {
    onMemberIdsChange(memberIds.filter((id) => id !== memberId));
  };

  // Add members to role
  const handleAddMembers = (newMemberIds: string[]) => {
    onMemberIdsChange([...memberIds, ...newMemberIds]);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search and Add Button */}
      <div className="flex items-center border-b border-border">
        <CollectionSearch
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search members..."
          className="flex-1 border-b-0"
        />
        {readOnly ? (
          <div className="pr-4">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Button variant="outline" size="sm" disabled>
                      <Plus size={16} />
                      Add Member
                    </Button>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Owner membership cannot be changed</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ) : (
          <div className="pr-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddMemberDialogOpen(true)}
            >
              <Plus size={16} />
              Add Member
            </Button>
          </div>
        )}
      </div>

      {/* Members List */}
      <div className="flex-1 overflow-auto">
        {roleMembers.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <h3 className="text-lg font-medium mb-2">No members</h3>
              <p className="text-sm text-muted-foreground">
                Add members to this role to grant them the configured
                permissions.
              </p>
            </div>
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">
              No members match "{searchQuery}"
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {filteredMembers.map((member) => (
              <div
                key={member.id}
                className="flex items-center gap-3 p-3 rounded-lg bg-muted/30"
              >
                <Avatar
                  url={member.user?.image ?? undefined}
                  fallback={getInitials(member.user?.name)}
                  shape="circle"
                  size="sm"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {member.user?.name || "Unknown"}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {member.user?.email}
                  </p>
                </div>
                {readOnly ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <Button variant="ghost" size="sm" disabled>
                            <X size={16} />
                          </Button>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Owner membership cannot be changed</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeMember(member.id)}
                  >
                    <X size={16} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <AddMemberDialog
        open={addMemberDialogOpen}
        onOpenChange={setAddMemberDialogOpen}
        selectedMemberIds={memberIds}
        onAddMembers={handleAddMembers}
      />
    </div>
  );
}

function MembersTab(props: MembersTabProps) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Loading01 size={24} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <MembersTabContent {...props} />
    </Suspense>
  );
}

// ============================================================================
// Built-in Role Helper
// ============================================================================

const BUILTIN_ROLE_PERMISSIONS: Record<"owner" | "admin" | "user", string[]> = {
  owner: [], // Owner has all permissions
  admin: [], // Admin has all permissions
  user: [], // User has no organization permissions by default
};

// Helper to load built-in role into form data
function loadBuiltinRoleIntoForm(
  role: "owner" | "admin" | "user",
  members: Array<{ id: string; role: string }>,
): RoleFormData {
  const isOwnerOrAdmin = role === "owner" || role === "admin";
  const roleMembers = members.filter((m) => m.role === role);

  return {
    role: {
      slug: role,
      label: role.charAt(0).toUpperCase() + role.slice(1),
    },
    allowAllStaticPermissions: isOwnerOrAdmin,
    staticPermissions: BUILTIN_ROLE_PERMISSIONS[role],
    toolSet: {},
    allowAllModels: true,
    modelSet: {},
    memberIds: roleMembers.map((m) => m.id),
  };
}

// ============================================================================
// Main Component
// ============================================================================

export function ManageRolesDialog({
  trigger,
  onSuccess,
}: ManageRolesDialogProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "mcp" | "org" | "models" | "members"
  >("mcp");
  const { locator } = useProjectContext();
  const queryClient = useQueryClient();

  // Get all connections for selection
  const connections = useConnections() ?? [];

  // Get existing custom roles
  const { customRoles, refetch: refetchRoles } = useOrganizationRoles();

  // Get members
  const { data: membersData } = useQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => authClient.organization.listMembers(),
  });

  // React Hook Form setup - single role at a time
  const form = useForm<RoleFormData>({
    resolver: zodResolver(roleFormSchema),
    defaultValues: createEmptyRole(),
  });

  // Form validity from Zod schema (requires roleName)
  const isFormValid = form.formState.isValid;
  const isFormDirty = form.formState.isDirty;

  // Track which role is selected (by ID for existing, null for new)
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  // Track if viewing a built-in role (owner, admin, user)
  const [viewingBuiltinRole, setViewingBuiltinRole] = useState<
    "owner" | "admin" | "user" | null
  >(null);

  // Check if editing a new role (not yet saved) - exclude built-in roles
  const isNewRole =
    !form.watch("role.id") && !form.watch("role.slug") && !viewingBuiltinRole;

  // Delete confirmation dialog state
  const [roleToDelete, setRoleToDelete] = useState<{
    id: string;
    label: string;
  } | null>(null);

  // Discard changes confirmation dialog state
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Convert existing OrganizationRole to form data
  const convertRoleToFormData = (role: OrganizationRole): RoleFormData => {
    const permission = role.permission || {};

    // Check for static permissions under "self"
    const selfPerms = permission["self"] || [];
    const hasAllStaticPerms = selfPerms.includes("*");
    const staticPerms = hasAllStaticPerms
      ? []
      : selfPerms.filter((p) => p !== "*");

    // Build toolSet from connection permissions
    const toolSet: Record<string, string[]> = {};
    for (const [key, tools] of Object.entries(permission)) {
      if (key === "self" || key === "models") continue;
      if (key === "*") {
        // All connections - expand to all current connections
        for (const conn of connections) {
          if (tools.includes("*")) {
            toolSet[conn.id] = conn.tools?.map((t) => t.name) ?? [];
          } else {
            toolSet[conn.id] = tools;
          }
        }
      } else {
        // Specific connection
        const conn = connections.find((c) => c.id === key);
        if (conn) {
          if (tools.includes("*")) {
            toolSet[key] = conn.tools?.map((t) => t.name) ?? [];
          } else {
            toolSet[key] = tools;
          }
        }
      }
    }

    // Build modelSet from "models" key (composite keyId:modelId strings)
    const modelsEntries = permission["models"] || [];
    const hasAllModels =
      modelsEntries.length === 0 || modelsEntries.includes("*:*");
    const modelSet: Record<string, string[]> = {};
    if (!hasAllModels) {
      for (const entry of modelsEntries) {
        const colonIdx = entry.indexOf(":");
        if (colonIdx === -1) continue;
        const keyId = entry.slice(0, colonIdx);
        const modelId = entry.slice(colonIdx + 1);
        if (!modelSet[keyId]) {
          modelSet[keyId] = [];
        }
        modelSet[keyId].push(modelId);
      }
    }

    // Get members with this role
    const members = membersData?.data?.members ?? [];
    const roleMemberIds = members
      .filter((m) => m.role === role.role)
      .map((m) => m.id);

    return {
      role: {
        id: role.id,
        slug: role.role,
        label: role.label,
      },
      allowAllStaticPermissions: hasAllStaticPerms,
      staticPermissions: staticPerms,
      toolSet,
      allowAllModels: hasAllModels,
      modelSet,
      memberIds: roleMemberIds,
    };
  };

  // Load a role into the form
  const loadRole = (role: OrganizationRole) => {
    const formData = convertRoleToFormData(role);
    form.reset(formData);
    setSelectedRoleId(role.id ?? null);
    setViewingBuiltinRole(null);
  };

  // Start editing a new role
  const startNewRole = () => {
    form.reset(createEmptyRole());
    setSelectedRoleId(null);
    setViewingBuiltinRole(null);
    setActiveTab("mcp");
  };

  // Handle switching roles - only prompt if there are valid unsaved changes
  const handleSelectRole = (role: OrganizationRole) => {
    if (isFormDirty && isFormValid) {
      // Has valid unsaved changes - ask what to do
      setPendingAction(() => () => loadRole(role));
      setDiscardDialogOpen(true);
    } else {
      // Form is either clean OR invalid - just switch
      loadRole(role);
    }
  };

  // Handle creating a new role - save current if valid, then start new
  const handleCreateNewRole = async () => {
    if (isFormDirty && isFormValid) {
      await saveCurrentRole();
    }
    startNewRole();
  };

  // Handle selecting a built-in role
  const handleSelectBuiltinRole = (role: "owner" | "admin" | "user") => {
    if (isFormDirty && isFormValid) {
      // Has valid unsaved changes - ask what to do
      setPendingAction(() => () => {
        const builtinFormData = loadBuiltinRoleIntoForm(
          role,
          membersData?.data?.members ?? [],
        );
        form.reset(builtinFormData);
        setViewingBuiltinRole(role);
        setSelectedRoleId(null);
        setActiveTab("org");
      });
      setDiscardDialogOpen(true);
    } else {
      // Form is clean or invalid - just switch
      const builtinFormData = loadBuiltinRoleIntoForm(
        role,
        membersData?.data?.members ?? [],
      );
      form.reset(builtinFormData);
      setViewingBuiltinRole(role);
      setSelectedRoleId(null);
      setActiveTab("org");
    }
  };

  // Handle dialog open/close
  const handleOpenChange = (isOpen: boolean) => {
    // Only prompt to discard if there are valid unsaved changes
    if (!isOpen && form.formState.isDirty && isFormValid) {
      setPendingAction(() => () => {
        setOpen(false);
        form.reset(createEmptyRole());
        setViewingBuiltinRole(null);
      });
      setDiscardDialogOpen(true);
      return;
    }
    setOpen(isOpen);

    if (!isOpen) {
      form.reset(createEmptyRole());
      setViewingBuiltinRole(null);
      setSelectedRoleId(null);
    } else {
      const firstRole = customRoles[0];
      if (firstRole) {
        loadRole(firstRole);
      } else {
        // If no custom roles, open the "user" built-in role
        const builtinFormData = loadBuiltinRoleIntoForm(
          "user",
          membersData?.data?.members ?? [],
        );
        form.reset(builtinFormData);
        setViewingBuiltinRole("user");
        setSelectedRoleId(null);
        setActiveTab("org");
      }
    }
  };

  // Confirm discard changes
  const handleConfirmDiscard = () => {
    setDiscardDialogOpen(false);
    if (pendingAction) {
      pendingAction();
      setPendingAction(null);
    }
  };

  // Build permission object from role form data
  const buildPermission = (role: RoleFormData): Record<string, string[]> => {
    const permission: Record<string, string[]> = {};

    // Add static/organization-level permissions under "self"
    if (role.allowAllStaticPermissions) {
      permission["self"] = ["*"];
    } else if (role.staticPermissions.length > 0) {
      permission["self"] = role.staticPermissions;
    }

    // Add connection/tool permissions
    for (const [connectionId, tools] of Object.entries(role.toolSet)) {
      if (tools.length > 0) {
        const conn = connections.find((c) => c.id === connectionId);
        const allTools = conn?.tools?.map((t) => t.name) ?? [];
        // If all tools selected, use wildcard
        if (allTools.length > 0 && allTools.every((t) => tools.includes(t))) {
          permission[connectionId] = ["*"];
        } else {
          permission[connectionId] = tools;
        }
      }
    }

    // Add model permissions as composite "keyId:modelId" strings
    if (role.allowAllModels) {
      permission["models"] = ["*:*"];
    } else {
      const modelEntries: string[] = [];
      for (const [keyId, models] of Object.entries(role.modelSet)) {
        if (models.length > 0) {
          for (const modelId of models) {
            modelEntries.push(`${keyId}:${modelId}`);
          }
        }
      }
      // Always set the key when allowAllModels is false — an empty array
      // means "no models allowed". Omitting the key would mean "all allowed"
      // per the backward-compat data model, which is the opposite of intent.
      permission["models"] = modelEntries;
    }

    return permission;
  };

  // Save mutation for single role
  const saveMutation = useMutation({
    mutationFn: async (formData: RoleFormData) => {
      const permission = buildPermission(formData);
      const roleSlug =
        formData.role.slug ||
        formData.role.label.toLowerCase().replace(/\s+/g, "-");

      // Check if this is a built-in role (has slug but no id)
      const isBuiltinRole = formData.role.slug && !formData.role.id;

      if (isBuiltinRole) {
        // Built-in role - only update member assignments
        const members = membersData?.data?.members ?? [];
        const currentMemberIds = members
          .filter((m) => m.role === formData.role.slug)
          .map((m) => m.id);

        // Find members to add
        const membersToAdd = formData.memberIds.filter(
          (id) => !currentMemberIds.includes(id),
        );

        // Find members to remove
        const membersToRemove = currentMemberIds.filter(
          (id) => !formData.memberIds.includes(id),
        );

        // Add new members to this role
        for (const memberId of membersToAdd) {
          const memberResult = await authClient.organization.updateMemberRole({
            memberId,
            role: [formData.role.slug!],
          });
          if (memberResult?.error) {
            throw new Error(memberResult.error.message);
          }
        }

        // Remove members from this role
        for (const memberId of membersToRemove) {
          const memberResult = await authClient.organization.updateMemberRole({
            memberId,
            role: ["user"],
          });
          if (memberResult?.error) {
            throw new Error(memberResult.error.message);
          }
        }

        return formData;
      } else if (formData.role.id) {
        // Update existing custom role
        const result = await authClient.organization.updateRole({
          roleId: formData.role.id,
          data: { permission },
        });

        if (result?.error) {
          throw new Error(result.error.message);
        }

        // Update member assignments
        const members = membersData?.data?.members ?? [];
        const currentMemberIds = members
          .filter((m) => m.role === formData.role.slug)
          .map((m) => m.id);

        // Find members to add
        const membersToAdd = formData.memberIds.filter(
          (id) => !currentMemberIds.includes(id),
        );

        // Find members to remove
        const membersToRemove = currentMemberIds.filter(
          (id) => !formData.memberIds.includes(id),
        );

        // Add new members to this role
        for (const memberId of membersToAdd) {
          const memberResult = await authClient.organization.updateMemberRole({
            memberId,
            role: [formData.role.slug!],
          });
          if (memberResult?.error) {
            throw new Error(memberResult.error.message);
          }
        }

        // Remove members from this role
        for (const memberId of membersToRemove) {
          const memberResult = await authClient.organization.updateMemberRole({
            memberId,
            role: ["user"],
          });
          if (memberResult?.error) {
            throw new Error(memberResult.error.message);
          }
        }

        return formData;
      } else {
        // Create new role
        const result = await authClient.organization.createRole({
          role: roleSlug,
          permission,
        });

        if (result?.error) {
          throw new Error(result.error.message);
        }

        // Assign members to the new role
        for (const memberId of formData.memberIds) {
          const memberResult = await authClient.organization.updateMemberRole({
            memberId,
            role: [roleSlug],
          });
          if (memberResult?.error) {
            throw new Error(memberResult.error.message);
          }
        }

        return {
          ...formData,
          role: {
            ...formData.role,
            id: result.data?.roleData?.id,
            slug: roleSlug,
          },
        };
      }
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: KEYS.members(locator) });
      queryClient.invalidateQueries({
        queryKey: KEYS.organizationRoles(locator),
      });
      const isNew = !variables.role.id && !variables.role.slug;
      const isBuiltinRole = variables.role.slug && !variables.role.id;
      toast.success(
        isBuiltinRole
          ? "Members updated successfully!"
          : isNew
            ? "Role created successfully!"
            : "Role updated successfully!",
      );
      refetchRoles();
      form.reset(data);
      if (data.role.id) {
        setSelectedRoleId(data.role.id);
      }
      onSuccess?.();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to save role",
      );
    },
  });

  const deleteRoleMutation = useMutation({
    mutationFn: async (roleId: string) => {
      const result = await authClient.organization.deleteRole({ roleId });

      if (result?.error) {
        throw new Error(result.error.message);
      }

      return result?.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.members(locator) });
      queryClient.invalidateQueries({
        queryKey: KEYS.organizationRoles(locator),
      });
      toast.success("Role deleted successfully!");
      refetchRoles();
      // If the deleted role was the one being edited, load another role
      if (roleToDelete?.id === selectedRoleId) {
        const remainingRoles = customRoles.filter(
          (r) => r.id !== roleToDelete?.id,
        );
        if (remainingRoles[0]) {
          loadRole(remainingRoles[0]);
        } else {
          // No custom roles left, load the "user" built-in role
          const builtinFormData = loadBuiltinRoleIntoForm(
            "user",
            membersData?.data?.members ?? [],
          );
          form.reset(builtinFormData);
          setViewingBuiltinRole("user");
          setSelectedRoleId(null);
          setActiveTab("org");
        }
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete role",
      );
    },
  });

  const isPending = saveMutation.isPending || deleteRoleMutation.isPending;

  // Save current role
  const saveCurrentRole = async () => {
    const data = form.getValues();

    if (!data.role.label.trim()) {
      toast.error("Role name is required");
      form.setFocus("role.label");
      return;
    }

    await saveMutation.mutateAsync(data);
  };

  const handleSubmit = form.handleSubmit((data) => {
    if (!data.role.label.trim()) {
      toast.error("Role name is required");
      form.setFocus("role.label");
      return;
    }
    saveMutation.mutate(data);
  });

  // Handle delete role
  const handleDeleteRole = (role: OrganizationRole) => {
    if (role.id) {
      setRoleToDelete({ id: role.id, label: role.label });
    }
  };

  // Confirm delete
  const handleConfirmDelete = () => {
    if (roleToDelete?.id) {
      deleteRoleMutation.mutate(roleToDelete.id);
    }
    setRoleToDelete(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-5xl h-[80vh] max-h-[80vh] flex flex-col p-0 overflow-hidden w-[95vw]">
        <div className="flex-1 flex overflow-hidden min-h-0 flex-col sm:flex-row">
          {/* Left Sidebar - Roles List */}
          <div className="w-full sm:w-64 sm:border-r border-b sm:border-b-0 border-border flex flex-col bg-background sm:h-full max-h-[40vh] sm:max-h-full">
            {/* Roles List */}
            <div className="flex-1 overflow-auto px-3.5 py-3.5 pt-3.5">
              <div className="flex flex-col gap-1">
                {/* Built-in Roles (Read-only but viewable) */}
                {BUILTIN_ROLES.map((builtinRole) => {
                  const isSelected = viewingBuiltinRole === builtinRole.role;

                  return (
                    <div
                      key={builtinRole.role}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded-lg overflow-hidden cursor-pointer transition-colors",
                        isSelected ? "bg-accent" : "hover:bg-muted/50",
                      )}
                      onClick={() => handleSelectBuiltinRole(builtinRole.role)}
                    >
                      <div
                        className={cn(
                          "shrink-0 size-3 rounded-full",
                          builtinRole.color,
                        )}
                      />
                      <p className="text-sm font-medium truncate flex-1">
                        {builtinRole.label}
                      </p>
                      <Lock01
                        size={14}
                        className="text-muted-foreground shrink-0"
                      />
                    </div>
                  );
                })}

                {/* Custom Roles from Server */}
                {customRoles.map((role) => {
                  const isSelected = selectedRoleId === role.id;

                  return (
                    <div
                      key={role.id}
                      className={cn(
                        "group flex items-center gap-2 px-2 py-1.5 rounded-lg overflow-hidden transition-colors cursor-pointer",
                        isSelected ? "bg-accent" : "hover:bg-muted/50",
                      )}
                      onClick={() => handleSelectRole(role)}
                    >
                      <div
                        className={cn(
                          "shrink-0 size-3 rounded-full",
                          getRoleColor(role.label),
                        )}
                      />
                      <p className="text-sm font-medium truncate flex-1">
                        {role.label}
                      </p>

                      {/* Always show delete for custom roles */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "size-5 shrink-0 transition-opacity opacity-0 pointer-events-none",
                              "group-hover:opacity-100 group-hover:pointer-events-auto",
                              isSelected && "opacity-100 pointer-events-auto",
                            )}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DotsHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteRole(role);
                            }}
                          >
                            <Trash01 size={16} />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}

                {/* New Role being edited */}
                {isNewRole && (
                  <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg overflow-hidden bg-accent">
                    <div className="shrink-0 size-3 rounded-full bg-neutral-400" />
                    <Input
                      {...form.register("role.label")}
                      placeholder="Enter role name"
                      className="flex-1 text-sm font-medium border-0 shadow-none h-auto px-0 py-0 focus-visible:ring-0 bg-transparent"
                      autoFocus
                    />
                    <Badge
                      variant="secondary"
                      className="shrink-0 text-xs px-1.5 py-0"
                    >
                      New
                    </Badge>
                  </div>
                )}
              </div>
            </div>

            {/* Create New Role Button */}
            <div className="px-3.5 pb-3.5">
              <Button
                variant="outline"
                size="default"
                onClick={handleCreateNewRole}
                disabled={isPending || isFormDirty}
                className="w-full h-10"
              >
                <Plus size={16} />
                Create new role
              </Button>
            </div>
          </div>

          {/* Right Side - Role Editor */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Tab Buttons */}
            <div className="h-12 border-b border-border px-4 py-3.5 flex items-center gap-2 shrink-0">
              {!viewingBuiltinRole && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveTab("mcp")}
                  className={cn(
                    "h-7 rounded-lg px-2 border border-input transition-colors",
                    activeTab === "mcp"
                      ? "bg-accent border-border text-foreground"
                      : "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  MCP Permissions
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setActiveTab("org")}
                className={cn(
                  "h-7 rounded-lg px-2 border border-input transition-colors",
                  activeTab === "org"
                    ? "bg-accent border-border text-foreground"
                    : "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
                )}
              >
                Organization Permissions
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setActiveTab("models")}
                className={cn(
                  "h-7 rounded-lg px-2 border border-input transition-colors",
                  activeTab === "models"
                    ? "bg-accent border-border text-foreground"
                    : "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
                )}
              >
                Models
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setActiveTab("members")}
                className={cn(
                  "h-7 rounded-lg px-2 border border-input transition-colors",
                  activeTab === "members"
                    ? "bg-accent border-border text-foreground"
                    : "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
                )}
              >
                Members
              </Button>
            </div>

            {/* Tab Content — unmount eagerly when dialog closes to avoid
                tearing down hundreds of DOM nodes during the close animation */}
            <div className="flex-1 overflow-hidden min-h-0">
              {open && activeTab === "mcp" && !viewingBuiltinRole && (
                <ToolSetSelector
                  toolSet={form.watch("toolSet")}
                  onToolSetChange={(newToolSet) =>
                    form.setValue("toolSet", newToolSet, { shouldDirty: true })
                  }
                />
              )}
              {open && activeTab === "org" && (
                <OrgPermissionsTab
                  allowAllStaticPermissions={form.watch(
                    "allowAllStaticPermissions",
                  )}
                  staticPermissions={form.watch("staticPermissions")}
                  onAllowAllChange={(allowAll) =>
                    form.setValue("allowAllStaticPermissions", allowAll, {
                      shouldDirty: true,
                    })
                  }
                  onPermissionsChange={(permissions) =>
                    form.setValue("staticPermissions", permissions, {
                      shouldDirty: true,
                    })
                  }
                  readOnly={!!viewingBuiltinRole}
                />
              )}
              {open && activeTab === "models" && (
                <ModelsPermissionsTab
                  allowAllModels={form.watch("allowAllModels")}
                  modelSet={form.watch("modelSet")}
                  onAllowAllChange={(allowAll) =>
                    form.setValue("allowAllModels", allowAll, {
                      shouldDirty: true,
                    })
                  }
                  onModelSetChange={(newModelSet) =>
                    form.setValue("modelSet", newModelSet, {
                      shouldDirty: true,
                    })
                  }
                  readOnly={!!viewingBuiltinRole}
                />
              )}
              {open && activeTab === "members" && (
                <MembersTab
                  memberIds={form.watch("memberIds")}
                  onMemberIdsChange={(newMemberIds) =>
                    form.setValue("memberIds", newMemberIds, {
                      shouldDirty: true,
                    })
                  }
                  readOnly={viewingBuiltinRole === "owner"}
                />
              )}
            </div>

            {/* Footer - show for custom roles and non-owner built-in roles */}
            {(!viewingBuiltinRole || viewingBuiltinRole !== "owner") && (
              <div className="border-t border-border px-5 py-5 flex items-center justify-end gap-2.5 shrink-0">
                <Button
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={isPending}
                  className="h-10"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={
                    isPending || !isFormValid || !form.formState.isDirty
                  }
                  className="h-10"
                >
                  {saveMutation.isPending
                    ? "Saving..."
                    : isNewRole
                      ? "Create Role"
                      : "Save Changes"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>

      {/* Delete Confirmation Dialog */}
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
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discard Changes Confirmation Dialog */}
      <AlertDialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Are you sure you want to discard them?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingAction(null)}>
              Keep Editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDiscard}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

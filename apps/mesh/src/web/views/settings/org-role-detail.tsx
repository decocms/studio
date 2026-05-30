import {
  BASIC_USAGE_TOOLS,
  getCapabilitySections,
  isCapabilityEnabled,
  toggleCapabilityInTools,
  type PermissionCapability,
} from "@/tools/registry-metadata";
import { DEFAULT_LOGO, PROVIDER_LOGOS } from "@/web/utils/ai-providers-logos";
import { ToolSetSelector } from "@/web/components/tool-set-selector.tsx";
import { useMembers } from "@/web/hooks/use-members";
import { type OrganizationRole } from "@/web/hooks/use-organization-roles";
import { useOrgAuthClient } from "@/web/hooks/use-org-auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { track } from "@/web/lib/posthog-client";
import {
  useConnections,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import {
  type AiProviderKey,
  useAiProviderKeys,
  useSuspenseAiProviderModels,
} from "@/web/hooks/collections/use-ai-providers";
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
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Page } from "@/web/components/page";
import { IntegrationIcon } from "@/web/components/integration-icon";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loading01,
  Lock01,
  Plus,
  X,
} from "@untitledui/icons";

// ============================================================================
// Types
// ============================================================================

export type RoleEditorTarget =
  | {
      kind: "builtin";
      role: "owner" | "admin" | "user";
      storedId?: string;
      storedPermission?: Record<string, string[]>;
    }
  | { kind: "custom"; role: OrganizationRole }
  | { kind: "new" };

// ============================================================================
// Role color helpers
// ============================================================================

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

const BUILTIN_ROLE_COLORS: Record<string, string> = {
  owner: "bg-red-500",
  admin: "bg-blue-500",
  user: "bg-green-500",
};

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

function getRoleDotColor(roleSlug: string, isBuiltin: boolean): string {
  if (isBuiltin) return BUILTIN_ROLE_COLORS[roleSlug] ?? "bg-neutral-400";
  return getRoleColor(roleSlug);
}

// ============================================================================
// Zod Schema
// ============================================================================

const roleFormSchema = z.object({
  role: z.object({
    id: z.string().optional(),
    slug: z.string().optional(),
    label: z.string(),
  }),
  allowAllStaticPermissions: z.boolean(),
  staticPermissions: z.array(z.string()),
  toolSet: z.record(z.string(), z.array(z.string())),
  allowAllModels: z.boolean(),
  modelSet: z.record(z.string(), z.array(z.string())),
  memberIds: z.array(z.string()),
});

type RoleFormData = z.infer<typeof roleFormSchema>;

function getInitials(name: string | undefined | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
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
  searchQuery: string;
}

function makeToggle(checked: boolean, readOnly: boolean, onToggle: () => void) {
  const sw = (
    <Switch checked={checked} disabled={readOnly} onCheckedChange={onToggle} />
  );
  if (!readOnly) return sw;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>{sw}</div>
        </TooltipTrigger>
        <TooltipContent>
          <p>Built-in role permissions cannot be changed</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function OrgPermissionsTab({
  allowAllStaticPermissions,
  staticPermissions,
  onAllowAllChange,
  onPermissionsChange,
  readOnly = false,
  searchQuery,
}: OrgPermissionsTabProps) {
  const deferredQuery = useDeferredValue(searchQuery.trim().toLowerCase());
  const sections = getCapabilitySections();

  const toggleCapability = (
    cap: PermissionCapability,
    currentEnabled: boolean,
  ) => {
    if (readOnly) return;
    if (allowAllStaticPermissions && currentEnabled) {
      const allTools = sections
        .flatMap((s) => s.capabilities)
        .flatMap((c) => c.tools);
      onAllowAllChange(false);
      onPermissionsChange(allTools.filter((t) => !cap.tools.includes(t)));
      return;
    }
    if (allowAllStaticPermissions) return;
    onPermissionsChange(
      toggleCapabilityInTools(cap, staticPermissions, !currentEnabled),
    );
  };

  const filteredSections = sections
    .map(({ section, capabilities }) => ({
      section,
      capabilities: capabilities.filter(
        (cap) =>
          !deferredQuery ||
          cap.label.toLowerCase().includes(deferredQuery) ||
          cap.description.toLowerCase().includes(deferredQuery),
      ),
    }))
    .filter((s) => s.capabilities.length > 0);

  return (
    <div>
      <div className="flex flex-col gap-10 py-4">
        <SettingsSection title="General">
          <SettingsCard>
            <SettingsCardItem
              title="All organization permissions"
              description="Grant full access to all features below"
              action={makeToggle(allowAllStaticPermissions, readOnly, () => {
                onAllowAllChange(!allowAllStaticPermissions);
                onPermissionsChange([]);
              })}
              onClick={
                readOnly
                  ? undefined
                  : () => {
                      onAllowAllChange(!allowAllStaticPermissions);
                      onPermissionsChange([]);
                    }
              }
            />
          </SettingsCard>
        </SettingsSection>

        {filteredSections.length === 0 && deferredQuery ? (
          <p className="text-sm text-muted-foreground py-4">
            No permissions match &ldquo;{searchQuery}&rdquo;
          </p>
        ) : (
          filteredSections.map(({ section, capabilities }) => (
            <SettingsSection key={section} title={section}>
              <SettingsCard>
                {capabilities.map((cap) => {
                  const enabled = isCapabilityEnabled(
                    cap,
                    staticPermissions,
                    allowAllStaticPermissions,
                  );
                  return (
                    <SettingsCardItem
                      key={cap.id}
                      title={
                        <span className="flex items-center gap-1.5">
                          {cap.label}
                          {cap.dangerous && (
                            <AlertTriangle
                              size={12}
                              className="text-amber-500 shrink-0"
                            />
                          )}
                        </span>
                      }
                      description={cap.description}
                      action={makeToggle(enabled, readOnly, () =>
                        toggleCapability(cap, enabled),
                      )}
                      onClick={
                        readOnly
                          ? undefined
                          : () => toggleCapability(cap, enabled)
                      }
                    />
                  );
                })}
              </SettingsCard>
            </SettingsSection>
          ))
        )}
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

const SUB_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  "x-ai": "xAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  moonshotai: "MoonshotAI",
  nvidia: "NVIDIA",
  perplexity: "Perplexity",
  cohere: "Cohere",
  amazon: "Amazon",
  microsoft: "Microsoft",
  "z-ai": "Z.ai",
  "ibm-granite": "IBM Granite",
  alibaba: "Alibaba",
  baidu: "Baidu",
  bytedance: "ByteDance",
  tencent: "Tencent",
  minimax: "MiniMax",
  nousresearch: "Nous Research",
  allenai: "Allen AI",
  inception: "Inception",
};

function getSubProviderId(modelId: string, fallback: string): string {
  const slash = modelId.indexOf("/");
  const raw = slash > 0 ? modelId.slice(0, slash) : fallback;
  // OpenRouter prefixes BYOK / passthrough providers with `~` (e.g.
  // `~anthropic/claude-...`); normalize so they group with the canonical id.
  return raw.startsWith("~") ? raw.slice(1) : raw;
}

function getSubProviderDisplayName(id: string): string {
  return SUB_PROVIDER_DISPLAY_NAMES[id] ?? PROVIDER_DISPLAY_NAMES[id] ?? id;
}

function stripTitlePrefix(title: string): string {
  // OpenRouter titles look like "Anthropic: Claude Haiku Latest" — strip the
  // "<sub-provider>: " prefix since it's redundant under a grouped header.
  const colon = title.indexOf(": ");
  return colon > 0 && colon < 32 ? title.slice(colon + 2) : title;
}

interface ModelsPermissionsTabProps {
  allowAllModels: boolean;
  modelSet: Record<string, string[]>;
  onAllowAllChange: (allowAll: boolean) => void;
  onModelSetChange: (modelSet: Record<string, string[]>) => void;
  readOnly?: boolean;
  searchQuery: string;
}

const MODELS_PAGE_SIZE = 30;

type GroupedModel = {
  id: string;
  title: string;
  logo: string | null;
};

function SubProviderGroup({
  connectionId,
  subProviderId,
  subProviderName,
  groupLogo,
  models,
  allConnectionModelIds,
  selectedModels,
  allowAllModels,
  allConnectionModelsSelected,
  onToggleModel,
  onExitAllowAll,
  readOnly,
  defaultExpanded,
}: {
  connectionId: string;
  subProviderId: string;
  subProviderName: string;
  groupLogo: string | null;
  models: GroupedModel[];
  allConnectionModelIds: string[];
  selectedModels: string[];
  allowAllModels: boolean;
  allConnectionModelsSelected: boolean;
  onToggleModel: (keyId: string, modelId: string) => void;
  onExitAllowAll: (
    keyId: string,
    allModelIds: string[],
    excludeModelId: string,
  ) => void;
  readOnly: boolean;
  defaultExpanded: boolean;
}) {
  const [userExpanded, setUserExpanded] = useState(defaultExpanded);
  // Honor `defaultExpanded` whenever it's true (e.g. active search) so
  // matching groups expand automatically even after the user collapsed them
  // earlier.
  const expanded = defaultExpanded || userExpanded;
  const setExpanded = setUserExpanded;
  const [visibleCount, setVisibleCount] = useState(MODELS_PAGE_SIZE);

  const isModelEnabled = (modelId: string) =>
    allowAllModels ||
    allConnectionModelsSelected ||
    selectedModels.includes("*") ||
    selectedModels.includes(modelId);

  const enabledCount = models.filter((m) => isModelEnabled(m.id)).length;
  const visibleModels = models.slice(0, visibleCount);
  const hasMore = models.length > visibleCount;

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card">
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <IntegrationIcon
            icon={groupLogo ?? PROVIDER_LOGOS[subProviderId] ?? DEFAULT_LOGO}
            name={subProviderName}
            size="sm"
          />
          <span className="text-sm font-medium truncate">
            {subProviderName}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Badge variant="secondary" className="text-xs text-muted-foreground">
            {enabledCount}/{models.length} enabled
          </Badge>
          {expanded ? (
            <ChevronDown size={16} className="text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight
              size={16}
              className="text-muted-foreground shrink-0"
            />
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border bg-muted/20">
          {visibleModels.map((model) => {
            const isEnabled = isModelEnabled(model.id);
            const handleToggle = () => {
              if (readOnly) return;
              if (allowAllModels) {
                onExitAllowAll(connectionId, allConnectionModelIds, model.id);
                return;
              }
              onToggleModel(connectionId, model.id);
            };
            return (
              <div
                key={model.id}
                className={cn(
                  "flex items-center justify-between gap-3 px-4 py-3 border-b border-border last:border-b-0",
                  !readOnly && "hover:bg-muted/50 cursor-pointer",
                )}
                onClick={handleToggle}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-sm truncate">{model.title}</span>
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  {readOnly ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div>
                            <Switch
                              checked={isEnabled}
                              disabled
                              onCheckedChange={() => {}}
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
                      checked={isEnabled}
                      onCheckedChange={handleToggle}
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
              Show more ({models.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionModelsSection({
  connection,
  selectedModels,
  allowAllModels,
  onToggleModel,
  onExitAllowAll,
  allConnectionModelsSelected,
  searchQuery,
  readOnly,
}: {
  connection: AiProviderKey;
  selectedModels: string[];
  allowAllModels: boolean;
  onToggleModel: (keyId: string, modelId: string) => void;
  onExitAllowAll: (
    keyId: string,
    allModelIds: string[],
    excludeModelId: string,
  ) => void;
  allConnectionModelsSelected: boolean;
  searchQuery: string;
  readOnly: boolean;
}) {
  const rawModels = useSuspenseAiProviderModels(connection.id);
  const models = rawModels
    .filter((m, i, arr) => arr.findIndex((x) => x.modelId === m.modelId) === i)
    .map((m) => ({ ...m, id: m.modelId, provider: connection.label }));

  const q = searchQuery.trim().toLowerCase();
  const filteredModels = q
    ? models.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider?.toLowerCase().includes(q),
      )
    : models;

  if (filteredModels.length === 0) return null;

  const groupsMap = new Map<
    string,
    { models: GroupedModel[]; logo: string | null }
  >();
  for (const m of filteredModels) {
    const subId = getSubProviderId(m.id, connection.providerId);
    const entry = groupsMap.get(subId) ?? { models: [], logo: null };
    entry.models.push({
      id: m.id,
      title: stripTitlePrefix(m.title),
      logo: m.logo,
    });
    if (!entry.logo && m.logo) entry.logo = m.logo;
    groupsMap.set(subId, entry);
  }
  const groups = Array.from(groupsMap.entries())
    .map(([id, entry]) => ({
      id,
      name: getSubProviderDisplayName(id),
      logo: entry.logo,
      models: entry.models,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Auto-expand when there's only one group, or when actively searching.
  const autoExpand = groups.length === 1 || q.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <img
          src={PROVIDER_LOGOS[connection.providerId] ?? DEFAULT_LOGO}
          alt={connection.providerId}
          className="w-4 h-4 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
        />
        <h4 className="text-sm font-medium">
          {PROVIDER_DISPLAY_NAMES[connection.providerId] ??
            connection.providerId}
        </h4>
      </div>
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <SubProviderGroup
            key={group.id}
            connectionId={connection.id}
            subProviderId={group.id}
            subProviderName={group.name}
            groupLogo={group.logo}
            models={group.models}
            allConnectionModelIds={models.map((m) => m.id)}
            selectedModels={selectedModels}
            allowAllModels={allowAllModels}
            allConnectionModelsSelected={allConnectionModelsSelected}
            onToggleModel={onToggleModel}
            onExitAllowAll={onExitAllowAll}
            readOnly={readOnly}
            defaultExpanded={autoExpand}
          />
        ))}
      </div>
    </div>
  );
}

function ModelsPermissionsTab({
  allowAllModels,
  modelSet,
  onAllowAllChange,
  onModelSetChange,
  readOnly = false,
  searchQuery,
}: ModelsPermissionsTabProps) {
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const allModelsConnections = useAiProviderKeys();

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

  // Switch from "all models" to a specific selection while preserving every
  // model in the clicked connection except the one the user just turned off.
  const exitAllowAll = (
    connectionId: string,
    allModelIds: string[],
    excludeModelId: string,
  ) => {
    onAllowAllChange(false);
    onModelSetChange({
      ...modelSet,
      [connectionId]: allModelIds.filter((id) => id !== excludeModelId),
    });
  };

  return (
    <div className="flex flex-col h-full overflow-auto gap-6 pb-6">
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3 rounded-lg border border-border bg-card",
          !readOnly && "hover:bg-muted/50 cursor-pointer",
        )}
        onClick={() => {
          if (readOnly) return;
          const newValue = !allowAllModels;
          onAllowAllChange(newValue);
          if (newValue) onModelSetChange({});
        }}
      >
        <span className="text-sm font-medium">All models</span>
        <div onClick={(e) => e.stopPropagation()}>
          {readOnly ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Switch
                      checked={allowAllModels}
                      disabled
                      onCheckedChange={() => {}}
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
              checked={allowAllModels}
              onCheckedChange={(checked) => {
                onAllowAllChange(checked);
                if (checked) onModelSetChange({});
              }}
            />
          )}
        </div>
      </div>
      {allModelsConnections.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          No LLM connections configured
        </div>
      ) : (
        allModelsConnections.map((conn) => (
          <Suspense
            key={conn.id}
            fallback={
              <div className="px-4 py-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Loading01 className="size-4 animate-spin" />
                Loading models...
              </div>
            }
          >
            <ConnectionModelsSection
              connection={conn}
              selectedModels={modelSet[conn.id] ?? []}
              allowAllModels={allowAllModels}
              onToggleModel={toggleModel}
              onExitAllowAll={exitAllowAll}
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
  );
}

// ============================================================================
// Add Member Dialog
// ============================================================================

function AddMemberDialog({
  open,
  onOpenChange,
  selectedMemberIds,
  onAddMembers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedMemberIds: string[];
  onAddMembers: (memberIds: string[]) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [pendingMemberIds, setPendingMemberIds] = useState<string[]>([]);

  const { data } = useMembers();
  const members = data?.data?.members ?? [];
  type Member = (typeof members)[number];

  const filteredMembers = members.filter((member: Member) => {
    const q = deferredSearchQuery.toLowerCase();
    return (
      member.user?.name?.toLowerCase().includes(q) ||
      member.user?.email?.toLowerCase().includes(q)
    );
  });

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
          <div className="border-b border-border px-4 py-3">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search members..."
              className="w-full"
            />
          </div>
          <div className="flex-1 overflow-auto">
            {filteredMembers.length === 0 ? (
              <div className="flex items-center justify-center h-full px-6">
                <p className="text-sm text-muted-foreground">
                  {searchQuery ? "No members found" : "No members available"}
                </p>
              </div>
            ) : (
              <div className="px-6 py-2 space-y-1">
                {filteredMembers.map((member: Member) => {
                  const eligible = member.role !== "owner";
                  const alreadyInRole = selectedMemberIds.includes(member.id);
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
                          if (!eligible || alreadyInRole) return;
                          setPendingMemberIds((prev) =>
                            prev.includes(member.id)
                              ? prev.filter((id) => id !== member.id)
                              : [...prev, member.id],
                          );
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

function MembersTabContent({
  memberIds,
  onMemberIdsChange,
  readOnly = false,
  searchQuery,
  addMemberDialogOpen,
  onAddMemberDialogOpenChange,
}: {
  memberIds: string[];
  onMemberIdsChange: (memberIds: string[]) => void;
  readOnly?: boolean;
  searchQuery: string;
  addMemberDialogOpen: boolean;
  onAddMemberDialogOpenChange: (open: boolean) => void;
}) {
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const { data } = useMembers();
  const members = data?.data?.members ?? [];
  type Member = (typeof members)[number];

  const roleMembers = members.filter((m: Member) => memberIds.includes(m.id));
  const filteredMembers = roleMembers.filter((member: Member) => {
    const q = deferredSearchQuery.toLowerCase();
    return (
      member.user?.name?.toLowerCase().includes(q) ||
      member.user?.email?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        {roleMembers.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <h3 className="text-base font-medium mb-1">No members</h3>
              <p className="text-sm text-muted-foreground">
                Add members to grant them the configured permissions.
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
            {filteredMembers.map((member: Member) => (
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
                    onClick={() =>
                      onMemberIdsChange(
                        memberIds.filter((id) => id !== member.id),
                      )
                    }
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
        onOpenChange={onAddMemberDialogOpenChange}
        selectedMemberIds={memberIds}
        onAddMembers={(ids) => onMemberIdsChange([...memberIds, ...ids])}
      />
    </div>
  );
}

function MembersTab(props: {
  memberIds: string[];
  onMemberIdsChange: (memberIds: string[]) => void;
  readOnly?: boolean;
  searchQuery: string;
  addMemberDialogOpen: boolean;
  onAddMemberDialogOpenChange: (open: boolean) => void;
}) {
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
// Built-in Role Helpers
// ============================================================================

const BUILTIN_ROLE_PERMISSIONS: Record<"owner" | "admin" | "user", string[]> = {
  owner: [],
  admin: [],
  user: [],
};

type MemberLike = { id: string; role: string };

function loadBuiltinRoleIntoForm(
  role: "owner" | "admin" | "user",
  members: Array<{ id: string; role: string }>,
  storedData?: { id?: string; permission?: Record<string, string[]> },
  connections?: ConnectionEntity[],
): RoleFormData {
  if (storedData?.permission != null && connections) {
    return convertRoleToFormData(
      {
        id: storedData.id,
        role,
        label: role.charAt(0).toUpperCase() + role.slice(1),
        isBuiltin: true,
        permission: storedData.permission,
      },
      members,
      connections,
    );
  }
  const isOwnerOrAdmin = role === "owner" || role === "admin";
  return {
    role: {
      id: storedData?.id,
      slug: role,
      label: role.charAt(0).toUpperCase() + role.slice(1),
    },
    allowAllStaticPermissions: isOwnerOrAdmin,
    staticPermissions: BUILTIN_ROLE_PERMISSIONS[role],
    toolSet: {},
    allowAllModels: true,
    modelSet: {},
    memberIds: members.filter((m) => m.role === role).map((m) => m.id),
  };
}

function convertRoleToFormData(
  role: OrganizationRole,
  members: MemberLike[],
  connections: ConnectionEntity[],
): RoleFormData {
  const permission = role.permission || {};
  const selfPerms = permission["self"] || [];
  const hasAllStaticPerms = selfPerms.includes("*");
  const staticPerms = hasAllStaticPerms
    ? []
    : selfPerms.filter((p) => p !== "*");

  const toolSet: Record<string, string[]> = {};
  for (const [key, tools] of Object.entries(permission)) {
    if (key === "self" || key === "models") continue;
    if (key === "*") {
      for (const conn of connections) {
        toolSet[conn.id] = tools.includes("*")
          ? (conn.tools?.map((t) => t.name) ?? [])
          : tools;
      }
    } else {
      const conn = connections.find((c) => c.id === key);
      if (conn) {
        toolSet[key] = tools.includes("*")
          ? (conn.tools?.map((t) => t.name) ?? [])
          : tools;
      }
    }
  }

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
      if (!modelSet[keyId]) modelSet[keyId] = [];
      modelSet[keyId].push(modelId);
    }
  }

  return {
    role: { id: role.id, slug: role.role, label: role.label },
    allowAllStaticPermissions: hasAllStaticPerms,
    staticPermissions: staticPerms,
    toolSet,
    allowAllModels: hasAllModels,
    modelSet,
    memberIds: members.filter((m) => m.role === role.role).map((m) => m.id),
  };
}

function buildPermission(
  data: RoleFormData,
  connections: ConnectionEntity[],
): Record<string, string[]> {
  const permission: Record<string, string[]> = {};
  if (data.allowAllStaticPermissions) {
    permission["self"] = ["*"];
  } else {
    const tools = new Set(data.staticPermissions);
    for (const tool of BASIC_USAGE_TOOLS) tools.add(tool);
    if (tools.size > 0) permission["self"] = Array.from(tools);
  }
  for (const [connectionId, tools] of Object.entries(data.toolSet)) {
    if (tools.length > 0) {
      const conn = connections.find((c) => c.id === connectionId);
      const allTools = conn?.tools?.map((t) => t.name) ?? [];
      permission[connectionId] =
        allTools.length > 0 && allTools.every((t) => tools.includes(t))
          ? ["*"]
          : tools;
    }
  }
  if (data.allowAllModels) {
    permission["models"] = ["*:*"];
  } else {
    const modelEntries: string[] = [];
    for (const [keyId, models] of Object.entries(data.modelSet)) {
      for (const modelId of models) {
        modelEntries.push(`${keyId}:${modelId}`);
      }
    }
    if (modelEntries.length > 0) permission["models"] = modelEntries;
  }
  return permission;
}

function getInitialFormValues(
  target: RoleEditorTarget,
  members: MemberLike[],
  connections: ConnectionEntity[],
): RoleFormData {
  if (target.kind === "builtin") {
    return loadBuiltinRoleIntoForm(
      target.role,
      members,
      target.storedId != null
        ? { id: target.storedId, permission: target.storedPermission }
        : undefined,
      connections,
    );
  }
  if (target.kind === "custom") {
    return convertRoleToFormData(target.role, members, connections);
  }
  return {
    role: { id: undefined, slug: undefined, label: "" },
    allowAllStaticPermissions: false,
    staticPermissions: [],
    toolSet: {},
    allowAllModels: true,
    modelSet: {},
    memberIds: [],
  };
}

// ============================================================================
// Role Detail Page
// ============================================================================

function MembersAddButton({
  readOnly,
  onOpen,
}: {
  readOnly: boolean;
  onOpen: () => void;
}) {
  if (readOnly) {
    return (
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
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={onOpen}>
      <Plus size={16} />
      Add Member
    </Button>
  );
}

interface RoleDetailPageProps {
  target: RoleEditorTarget;
  onBack: () => void;
  onSaved: (id: string | undefined) => void;
}

export function RoleDetailPage(props: RoleDetailPageProps) {
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const connections = useConnections();

  const { data: membersData, isPending: membersPending } = useQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => orgAuth.organization.listMembers(),
  });

  if (membersPending || !connections) {
    return (
      <Page>
        <div className="flex items-center justify-center h-full">
          <Loading01 size={32} className="animate-spin text-muted-foreground" />
        </div>
      </Page>
    );
  }

  const members: MemberLike[] = membersData?.data?.members ?? [];
  return (
    <RoleDetailPageInner
      {...props}
      members={members}
      connections={connections}
    />
  );
}

function RoleDetailPageInner({
  target,
  onBack,
  onSaved,
  members,
  connections,
}: RoleDetailPageProps & {
  members: MemberLike[];
  connections: ConnectionEntity[];
}) {
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const queryClient = useQueryClient();

  const isBuiltin = target.kind === "builtin";
  const isOwnerBuiltin = target.kind === "builtin" && target.role === "owner";
  const isNew = target.kind === "new";

  const [activeTab, setActiveTab] = useState<
    "mcp" | "org" | "models" | "members"
  >(isBuiltin ? "org" : "mcp");

  const form = useForm<RoleFormData>({
    resolver: zodResolver(roleFormSchema),
    defaultValues: getInitialFormValues(target, members, connections),
  });

  const isFormValid = form.formState.isValid;
  const isFormDirty = form.formState.isDirty;

  const saveMutation = useMutation({
    mutationFn: async (formData: RoleFormData) => {
      const permission = buildPermission(formData, connections);
      const roleSlug =
        formData.role.slug ||
        formData.role.label.toLowerCase().replace(/\s+/g, "-");
      const isOwnerBuiltinSave =
        formData.role.slug === "owner" && !formData.role.id;
      const isEditableBuiltinFirstSave =
        (formData.role.slug === "admin" || formData.role.slug === "user") &&
        !formData.role.id;

      const syncMembers = async (currentSlug: string) => {
        const currentIds = members
          .filter((m) => m.role === currentSlug)
          .map((m) => m.id);
        const toAdd = formData.memberIds.filter(
          (id) => !currentIds.includes(id),
        );
        const toRemove = currentIds.filter(
          (id: string) => !formData.memberIds.includes(id),
        );
        for (const memberId of toAdd) {
          const r = await orgAuth.organization.updateMemberRole({
            memberId,
            role: [currentSlug],
          });
          if (r?.error)
            throw new Error(r.error.message ?? "Something went wrong");
        }
        for (const memberId of toRemove) {
          const r = await orgAuth.organization.updateMemberRole({
            memberId,
            role: ["user"],
          });
          if (r?.error)
            throw new Error(r.error.message ?? "Something went wrong");
        }
      };

      if (isOwnerBuiltinSave) {
        await syncMembers("owner");
        return formData;
      } else if (formData.role.id) {
        const r = await orgAuth.organization.updateRole({
          roleId: formData.role.id,
          data: { permission },
        });
        if (r?.error)
          throw new Error(r.error.message ?? "Something went wrong");
        await syncMembers(formData.role.slug!);
        return formData;
      } else if (isEditableBuiltinFirstSave) {
        const r = await orgAuth.organization.createRole({
          role: formData.role.slug!,
          permission,
        });
        if (r?.error)
          throw new Error(r.error.message ?? "Something went wrong");
        await syncMembers(formData.role.slug!);
        return {
          ...formData,
          role: { ...formData.role, id: r.data?.roleData?.id },
        };
      } else {
        const r = await orgAuth.organization.createRole({
          role: roleSlug,
          permission,
        });
        if (r?.error)
          throw new Error(r.error.message ?? "Something went wrong");
        for (const memberId of formData.memberIds) {
          const mr = await orgAuth.organization.updateMemberRole({
            memberId,
            role: [roleSlug],
          });
          if (mr?.error) throw new Error(mr.error.message);
        }
        return {
          ...formData,
          role: {
            ...formData.role,
            id: r.data?.roleData?.id,
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
      const wasNew = !variables.role.id && !variables.role.slug;
      const wasOwnerBuiltin =
        variables.role.slug === "owner" && !variables.role.id;
      track(
        wasOwnerBuiltin
          ? "role_members_updated"
          : wasNew
            ? "role_created"
            : "role_updated",
        { role_slug: variables.role.slug ?? null },
      );
      toast.success(
        wasOwnerBuiltin
          ? "Members updated successfully!"
          : wasNew
            ? "Role created successfully!"
            : "Role updated successfully!",
      );
      form.reset(data);
      onSaved(data.role.id);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to save role",
      );
    },
  });

  const handleSubmit = form.handleSubmit((data) => {
    if (!data.role.label.trim()) {
      toast.error("Role name is required");
      form.setFocus("role.label");
      return;
    }
    saveMutation.mutate(data);
  });

  const showSaveActions = !isOwnerBuiltin;

  const roleName =
    target.kind === "builtin"
      ? target.role.charAt(0).toUpperCase() + target.role.slice(1)
      : target.kind === "custom"
        ? target.role.label
        : "";

  const tabs = [
    ...(!isOwnerBuiltin
      ? [{ id: "mcp" as const, label: "MCP Permissions" }]
      : []),
    { id: "org" as const, label: "Organization Permissions" },
    { id: "models" as const, label: "Models" },
    { id: "members" as const, label: "Members" },
  ];

  const [searchQuery, setSearchQuery] = useState("");
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);

  const handleTabChange = (tab: typeof activeTab) => {
    setActiveTab(tab);
    setSearchQuery("");
  };

  const searchPlaceholders: Record<string, string> = {
    mcp: "Search MCP servers...",
    org: "Search permissions...",
    models: "Search models...",
    members: "Search members...",
  };

  return (
    <Page>
      <Page.Content
        className={cn(
          "flex flex-col",
          activeTab !== "org" && "overflow-hidden",
        )}
      >
        <div className="shrink-0 mx-auto w-full max-w-[1200px] px-4 md:px-10 pt-8 md:pt-12 pb-4">
          <div className="flex flex-col gap-5">
            <Page.Title
              actions={
                showSaveActions && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onBack}
                      disabled={saveMutation.isPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSubmit}
                      disabled={
                        saveMutation.isPending || !isFormValid || !isFormDirty
                      }
                    >
                      {saveMutation.isPending
                        ? "Saving..."
                        : isNew
                          ? "Create Role"
                          : "Save Changes"}
                    </Button>
                  </>
                )
              }
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className={cn(
                    "size-2.5 rounded-full shrink-0",
                    target.kind === "builtin"
                      ? getRoleDotColor(target.role, true)
                      : target.kind === "custom"
                        ? getRoleDotColor(target.role.role, false)
                        : getRoleColor(form.watch("role.label")),
                  )}
                />
                {isOwnerBuiltin && (
                  <Lock01
                    size={16}
                    className="text-muted-foreground shrink-0"
                  />
                )}
                {isNew ? (
                  <input
                    {...form.register("role.label")}
                    placeholder="Role name"
                    className="leading-tight text-foreground bg-transparent border-none outline-none px-1 -mx-1 rounded hover:bg-input/25 focus:bg-input/25 transition-colors w-64 placeholder:text-muted-foreground/50"
                    autoFocus
                  />
                ) : (
                  <span className="truncate">{roleName}</span>
                )}
              </div>
            </Page.Title>

            <div className="flex items-center gap-2">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleTabChange(tab.id)}
                  className={cn(
                    "h-7 px-2 text-sm rounded-lg border border-input transition-colors inline-flex items-center",
                    activeTab === tab.id
                      ? "bg-accent border-border text-foreground"
                      : "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={searchPlaceholders[activeTab] ?? "Search..."}
                className="w-full md:w-[375px]"
              />
              {activeTab === "members" && (
                <MembersAddButton
                  readOnly={
                    target.kind === "builtin" && target.role === "owner"
                  }
                  onOpen={() => setAddMemberDialogOpen(true)}
                />
              )}
            </div>
          </div>
        </div>

        <div
          className={cn(
            "mx-auto w-full max-w-[1200px] px-4 md:px-10 pb-6",
            activeTab !== "org" && "flex-1 min-h-0",
          )}
        >
          <div
            className={cn(
              activeTab !== "org" && "h-full overflow-hidden",
              activeTab !== "models" &&
                activeTab !== "org" &&
                "border border-border rounded-xl bg-card",
            )}
          >
            {activeTab === "mcp" && !isOwnerBuiltin && (
              <ToolSetSelector
                toolSet={form.watch("toolSet")}
                onToolSetChange={(newToolSet) =>
                  form.setValue("toolSet", newToolSet, { shouldDirty: true })
                }
                searchQuery={searchQuery}
              />
            )}
            {activeTab === "org" && (
              <OrgPermissionsTab
                allowAllStaticPermissions={form.watch(
                  "allowAllStaticPermissions",
                )}
                staticPermissions={form.watch("staticPermissions")}
                onAllowAllChange={(v) =>
                  form.setValue("allowAllStaticPermissions", v, {
                    shouldDirty: true,
                  })
                }
                onPermissionsChange={(v) =>
                  form.setValue("staticPermissions", v, { shouldDirty: true })
                }
                readOnly={isOwnerBuiltin}
                searchQuery={searchQuery}
              />
            )}
            {activeTab === "models" && (
              <ModelsPermissionsTab
                allowAllModels={form.watch("allowAllModels")}
                modelSet={form.watch("modelSet")}
                onAllowAllChange={(v) =>
                  form.setValue("allowAllModels", v, { shouldDirty: true })
                }
                onModelSetChange={(v) =>
                  form.setValue("modelSet", v, { shouldDirty: true })
                }
                readOnly={isOwnerBuiltin}
                searchQuery={searchQuery}
              />
            )}
            {activeTab === "members" && (
              <MembersTab
                memberIds={form.watch("memberIds")}
                onMemberIdsChange={(v) =>
                  form.setValue("memberIds", v, { shouldDirty: true })
                }
                readOnly={target.kind === "builtin" && target.role === "owner"}
                searchQuery={searchQuery}
                addMemberDialogOpen={addMemberDialogOpen}
                onAddMemberDialogOpenChange={setAddMemberDialogOpen}
              />
            )}
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}

export function getTargetKey(target: RoleEditorTarget): string {
  if (target.kind === "builtin") return `builtin-${target.role}`;
  if (target.kind === "custom") return `custom-${target.role.id}`;
  return "new";
}

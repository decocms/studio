import { generatePrefixedId } from "@/shared/utils/generate-id";
import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { type TableColumn } from "@/web/components/collections/collection-table.tsx";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import { ConnectionStatus } from "@/web/components/connections/connection-status.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Page } from "@/web/components/page";
import type { RegistryItem } from "@/web/components/store/types";
import { User } from "@/web/components/user/user.tsx";
import { useRegistryConnections } from "@/web/hooks/use-binding";
import { useListState } from "@/web/hooks/use-list-state";
import { authClient } from "@/web/lib/auth-client";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import {
  extractItemsFromResponse,
  findListToolName,
} from "@/web/utils/registry-utils";
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
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ORG_ADMIN_PROJECT_SLUG,
  SELF_MCP_ALIAS_ID,
  useConnectionActions,
  useConnections,
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
  useVirtualMCPs,
  type ConnectionEntity,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  Container,
  DotsVertical,
  Eye,
  Globe02,
  Loading01,
  Plus,
  Terminal,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { Fragment, Suspense, useEffect, useReducer, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { formatTimeAgo } from "@/web/lib/format-time";

import type {
  HttpConnectionParameters,
  StdioConnectionParameters,
} from "@/tools/connection/schema";
import { isStdioParameters } from "@/tools/connection/schema";
import {
  EnvVarsEditor,
  envVarsToRecord,
  recordToEnvVars,
  type EnvVar,
} from "@/web/components/env-vars-editor";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** True when an HTTP/SSE connection has no token and no OAuth config */
function connectionNeedsAuth(c: ConnectionEntity): boolean {
  if (c.connection_type === "VIRTUAL" || c.connection_type === "STDIO") {
    return false;
  }
  return !c.connection_token && !c.oauth_config;
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

interface ConnectionGroup {
  type: "group";
  key: string;
  icon: string | null;
  title: string;
  connections: ConnectionEntity[];
}

interface SingleConnection {
  type: "single";
  connection: ConnectionEntity;
}

type GroupedItem = SingleConnection | ConnectionGroup;

function getGroupKey(c: ConnectionEntity): string {
  return c.title.trim().replace(/\s+\(\d+\)$/, "");
}

function groupConnections(connections: ConnectionEntity[]): GroupedItem[] {
  const buckets = new Map<string, ConnectionEntity[]>();
  for (const c of connections) {
    if (c.connection_type === "VIRTUAL") continue;
    const key = getGroupKey(c);
    const list = buckets.get(key);
    if (list) {
      list.push(c);
    } else {
      buckets.set(key, [c]);
    }
  }

  const items: GroupedItem[] = [];
  const seen = new Set<string>();

  for (const c of connections) {
    if (c.connection_type === "VIRTUAL") continue;
    const key = getGroupKey(c);
    if (seen.has(key)) continue;
    seen.add(key);

    const bucket = buckets.get(key)!;
    const first = bucket[0]!;
    if (bucket.length === 1) {
      items.push({ type: "single", connection: first });
    } else {
      items.push({
        type: "group",
        key,
        icon: first.icon,
        title: first.app_name
          ? first.title.replace(/\s*\(\d+\)\s*$/, "")
          : first.title,
        connections: bucket,
      });
    }
  }
  return items;
}

function getUniqueCreators(connections: ConnectionEntity[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of connections) {
    if (c.created_by && !seen.has(c.created_by)) {
      seen.add(c.created_by);
      result.push(c.created_by);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Connection type / status filter types
// ---------------------------------------------------------------------------

type ConnectionTypeFilter = "ALL" | "HTTP" | "SSE" | "Websocket" | "STDIO";

type ConnectionStatusFilter = "ALL" | "active" | "inactive" | "error";

function countByStatus(connections: ConnectionEntity[]) {
  let active = 0;
  let inactive = 0;
  let error = 0;
  for (const c of connections) {
    if (c.connection_type === "VIRTUAL") continue;
    if (c.status === "active") active++;
    else if (c.status === "error") error++;
    else inactive++;
  }
  return { active, inactive, error, total: active + inactive + error };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Environment variable schema
const envVarSchema = z.object({
  key: z.string(),
  value: z.string(),
});

// Form validation schema derived from ConnectionEntitySchema
// Pick the relevant fields and adapt for form use
const connectionFormSchema = z
  .object({
    title: z.string().min(1, "Name is required"),
    description: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    // UI type - includes "NPX" and "STDIO" which both map to STDIO internally
    ui_type: z.enum(["HTTP", "SSE", "Websocket", "NPX", "STDIO"]),
    // For HTTP/SSE/Websocket
    connection_url: z.string().optional(),
    connection_token: z.string().nullable().optional(),
    // For NPX
    npx_package: z.string().optional(),
    // For STDIO (custom command)
    stdio_command: z.string().optional(),
    stdio_args: z.string().optional(),
    stdio_cwd: z.string().optional(),
    // Shared: Environment variables for both NPX and STDIO
    env_vars: z.array(envVarSchema).optional(),
  })
  .refine(
    (data) => {
      if (data.ui_type === "NPX") {
        return !!data.npx_package?.trim();
      }
      return true;
    },
    { message: "NPM package is required", path: ["npx_package"] },
  )
  .refine(
    (data) => {
      if (data.ui_type === "STDIO") {
        return !!data.stdio_command?.trim();
      }
      return true;
    },
    { message: "Command is required", path: ["stdio_command"] },
  )
  .refine(
    (data) => {
      if (
        data.ui_type === "HTTP" ||
        data.ui_type === "SSE" ||
        data.ui_type === "Websocket"
      ) {
        return !!data.connection_url?.trim();
      }
      return true;
    },
    { message: "URL is required", path: ["connection_url"] },
  );

type ConnectionFormData = z.infer<typeof connectionFormSchema>;

type ConnectionProviderHint = {
  id: "github" | "perplexity" | "registry";
  title?: string;
  description?: string | null;
  token?: {
    label: string;
    placeholder?: string;
    helperText?: string;
  };
  envVarKeys?: string[];
};

function normalizeUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const normalizedPath =
      url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.origin}${normalizedPath}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function parseNpxLikeCommand(input: string): { packageName: string } | null {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const command = tokens[0]?.toLowerCase();
  if (command !== "npx" && command !== "bunx") return null;

  // Skip flags like -y, --yes
  const args = tokens.slice(1);
  const firstNonFlag = args.find((a) => !a.startsWith("-"));
  if (!firstNonFlag) return null;

  return { packageName: firstNonFlag };
}

function inferHardcodedProviderHint(params: {
  uiType: ConnectionFormData["ui_type"];
  connectionUrl?: string;
  npxPackage?: string;
}): ConnectionProviderHint | null {
  const { uiType } = params;

  // GitHub Copilot MCP (hardcoded)
  const normalized = normalizeUrl(params.connectionUrl ?? "");
  if (
    (uiType === "HTTP" || uiType === "SSE" || uiType === "Websocket") &&
    normalized === normalizeUrl("https://api.githubcopilot.com/mcp/")
  ) {
    return {
      id: "github",
      title: "GitHub",
      description: "GitHub Copilot MCP",
      token: {
        label: "GitHub PAT",
        placeholder: "github_pat_…",
        helperText: "Paste a GitHub Personal Access Token (PAT)",
      },
    };
  }

  // Perplexity MCP (hardcoded)
  const npxPackage = (params.npxPackage ?? "").trim();
  if (uiType === "NPX" && npxPackage === "@perplexity-ai/mcp-server") {
    return {
      id: "perplexity",
      title: "Perplexity",
      description: "Perplexity MCP Server",
      envVarKeys: ["PERPLEXITY_API_KEY"],
    };
  }

  return null;
}

function inferRegistryProviderHint(params: {
  uiType: ConnectionFormData["ui_type"];
  connectionUrl?: string;
  registryItems: RegistryItem[];
}): ConnectionProviderHint | null {
  if (params.registryItems.length === 0) return null;
  if (
    params.uiType !== "HTTP" &&
    params.uiType !== "SSE" &&
    params.uiType !== "Websocket"
  ) {
    return null;
  }

  const normalized = normalizeUrl(params.connectionUrl ?? "");
  if (!normalized) return null;

  const match = params.registryItems.find((item) => {
    const remotes = item.server?.remotes ?? [];
    return remotes.some((r) => normalizeUrl(r.url ?? "") === normalized);
  });

  if (!match) return null;

  const title =
    match.title ||
    match.name ||
    match.server?.title ||
    match.server?.name ||
    "";
  const description =
    match.server?.description || match.description || match.summary || null;

  if (!title) return null;

  return {
    id: "registry",
    title,
    description,
  };
}

/**
 * Build STDIO connection_headers from NPX form fields
 */
function buildNpxParameters(
  packageName: string,
  envVars: EnvVar[],
): StdioConnectionParameters {
  const params: StdioConnectionParameters = {
    command: "npx",
    args: ["-y", packageName],
  };
  const envRecord = envVarsToRecord(envVars);
  if (Object.keys(envRecord).length > 0) {
    params.envVars = envRecord;
  }
  return params;
}

/**
 * Build STDIO connection_headers from custom command form fields
 */
function buildCustomStdioParameters(
  command: string,
  argsString: string,
  cwd: string | undefined,
  envVars: EnvVar[],
): StdioConnectionParameters {
  const params: StdioConnectionParameters = {
    command: command,
  };

  if (argsString.trim()) {
    params.args = argsString.trim().split(/\s+/);
  }

  if (cwd?.trim()) {
    params.cwd = cwd.trim();
  }

  const envRecord = envVarsToRecord(envVars);
  if (Object.keys(envRecord).length > 0) {
    params.envVars = envRecord;
  }

  return params;
}

/**
 * Check if STDIO params look like an NPX command
 */
function isNpxCommand(params: StdioConnectionParameters): boolean {
  return params.command === "npx";
}

/**
 * Parse STDIO connection_headers back to NPX form fields
 */
function parseStdioToNpx(params: StdioConnectionParameters): string {
  return params.args?.find((a) => !a.startsWith("-")) ?? "";
}

/**
 * Parse STDIO connection_headers to custom command form fields
 */
function parseStdioToCustom(params: StdioConnectionParameters): {
  command: string;
  args: string;
  cwd: string;
} {
  return {
    command: params.command,
    args: params.args?.join(" ") ?? "",
    cwd: params.cwd ?? "",
  };
}

type DialogState =
  | { mode: "idle" }
  | { mode: "editing"; connection: ConnectionEntity }
  | { mode: "deleting"; connection: ConnectionEntity }
  | {
      mode: "force-deleting";
      connection: ConnectionEntity;
      agentNames: string;
    };

type DialogAction =
  | { type: "edit"; connection: ConnectionEntity }
  | { type: "delete"; connection: ConnectionEntity }
  | {
      type: "force-delete";
      connection: ConnectionEntity;
      agentNames: string;
    }
  | { type: "close" };

function dialogReducer(_state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "edit":
      return { mode: "editing", connection: action.connection };
    case "delete":
      return { mode: "deleting", connection: action.connection };
    case "force-delete":
      return {
        mode: "force-deleting",
        connection: action.connection,
        agentNames: action.agentNames,
      };
    case "close":
      return { mode: "idle" };
  }
}

// ---------------------------------------------------------------------------
// Grouped card: collapsible row for connections sharing the same app_name
// ---------------------------------------------------------------------------

function ConnectionGroupCard({
  group,
  onNavigate,
  onDelete,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: {
  group: ConnectionGroup;
  onNavigate: (id: string) => void;
  onDelete: (connection: ConnectionEntity) => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const allSelected = group.connections.every((c) => selectedIds.has(c.id));
  const someSelected = group.connections.some((c) => selectedIds.has(c.id));
  const creators = getUniqueCreators(group.connections);

  const mostRecent = group.connections.reduce((latest, c) => {
    const t = c.updated_at ?? c.created_at;
    const l = latest.updated_at ?? latest.created_at;
    if (!t) return latest;
    if (!l) return c;
    return new Date(t) > new Date(l) ? c : latest;
  }, group.connections[0]!);
  const recentTs = mostRecent.updated_at ?? mostRecent.created_at;

  return (
    <>
      <ConnectionCard
        connection={{
          title: group.title,
          icon: group.icon,
          description: `${group.connections.length} instances`,
        }}
        onClick={() =>
          selectionMode
            ? (() => {
                for (const c of group.connections) {
                  if (allSelected) {
                    if (selectedIds.has(c.id)) onToggleSelect(c.id);
                  } else {
                    if (!selectedIds.has(c.id)) onToggleSelect(c.id);
                  }
                }
              })()
            : setDialogOpen(true)
        }
        className={cn(
          selectionMode && allSelected && "ring-2 ring-primary",
          selectionMode &&
            someSelected &&
            !allSelected &&
            "ring-1 ring-primary/50",
        )}
        fallbackIcon={<Container />}
        headerActions={
          selectionMode ? (
            <Checkbox
              checked={
                allSelected ? true : someSelected ? "indeterminate" : false
              }
              onCheckedChange={() => {
                for (const c of group.connections) {
                  if (allSelected) {
                    if (selectedIds.has(c.id)) onToggleSelect(c.id);
                  } else {
                    if (!selectedIds.has(c.id)) onToggleSelect(c.id);
                  }
                }
              }}
            />
          ) : (
            <Badge variant="secondary" className="text-xs tabular-nums">
              x{group.connections.length}
            </Badge>
          )
        }
        body={
          <div className="flex items-center gap-1">
            {group.connections.slice(0, 6).map((c) => (
              <ConnectionStatus
                key={c.id}
                status={c.status}
                needsAuth={connectionNeedsAuth(c)}
              />
            ))}
          </div>
        }
        footer={
          <div className="flex items-center justify-between text-xs text-muted-foreground w-full min-w-0">
            <div className="flex items-center -space-x-1.5">
              {creators.map((id) => (
                <User
                  key={id}
                  id={id}
                  size="3xs"
                  avatarOnly={creators.length > 1}
                />
              ))}
            </div>
            <span className="shrink-0 ml-2">
              {recentTs ? formatTimeAgo(new Date(recentTs)) : "—"}
            </span>
          </div>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4">
            <div className="flex items-center gap-3">
              <IntegrationIcon
                icon={group.icon}
                name={group.title}
                size="md"
                className="shrink-0 shadow-sm"
                fallbackIcon={<Container />}
              />
              <div>
                <DialogTitle>
                  {group.title}
                  <Badge
                    variant="secondary"
                    className="ml-2 text-xs tabular-nums"
                  >
                    x{group.connections.length}
                  </Badge>
                </DialogTitle>
                <DialogDescription>
                  {group.connections.length} installed instances
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="divide-y max-h-80 overflow-auto">
            {group.connections.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 px-6 py-3 hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => {
                  setDialogOpen(false);
                  onNavigate(c.id);
                }}
              >
                <IntegrationIcon
                  icon={c.icon}
                  name={c.title}
                  size="sm"
                  className="shrink-0"
                  fallbackIcon={<Container />}
                />
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground truncate">
                    {c.title}
                  </span>
                  <ConnectionStatus
                    status={c.status}
                    needsAuth={connectionNeedsAuth(c)}
                  />
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                  <User id={c.created_by} size="3xs" />
                  <span>
                    {c.created_at ? formatTimeAgo(new Date(c.created_at)) : "—"}
                  </span>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
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
                      onClick={() => {
                        setDialogOpen(false);
                        onNavigate(c.id);
                      }}
                    >
                      <Eye size={16} />
                      Open
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDelete(c)}
                    >
                      <Trash01 size={16} />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Floating bulk action bar (centered, same pattern as private-registry)
// ---------------------------------------------------------------------------

function BulkActionBar({
  count,
  total,
  onSelectAll,
  onDeselectAll,
  onDelete,
  onAddToAgent,
  onToggleStatus,
  onCancel,
}: {
  count: number;
  total: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDelete: () => void;
  onAddToAgent: () => void;
  onToggleStatus: (status: "active" | "inactive") => void;
  onCancel: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="rounded-xl border border-border bg-background/95 shadow-lg backdrop-blur px-3 py-2 flex items-center gap-2">
        <div className="text-xs text-muted-foreground pr-1 tabular-nums">
          {count} selected
        </div>
        {count < total ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={onSelectAll}
          >
            Select all ({total})
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={onDeselectAll}
          >
            Clear selection
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs px-2"
          onClick={onAddToAgent}
        >
          <Plus size={13} />
          Add to Agent
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs px-2"
          onClick={() => onToggleStatus("active")}
        >
          Enable
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs px-2"
          onClick={() => onToggleStatus("inactive")}
        >
          Disable
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-xs px-2"
          onClick={onDelete}
        >
          <Trash01 size={13} />
          Delete
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2"
          onClick={onCancel}
        >
          <XClose size={13} />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add to Agent dialog
// ---------------------------------------------------------------------------

function AddToAgentDialog({
  open,
  onOpenChange,
  agents,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: VirtualMCPEntity[];
  onConfirm: (agentId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Add to Agent</DialogTitle>
          <DialogDescription>
            Select an agent to add the selected connections to.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-60 overflow-auto py-2 space-y-1">
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No agents found
            </p>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelected(agent.id)}
                className={cn(
                  "flex items-center gap-3 w-full rounded-md px-3 py-2 text-left transition-colors",
                  selected === agent.id
                    ? "bg-primary/10 ring-1 ring-primary"
                    : "hover:bg-muted/50",
                )}
              >
                <IntegrationIcon
                  icon={agent.icon}
                  name={agent.title}
                  size="sm"
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{agent.title}</p>
                  {agent.description && (
                    <p className="text-xs text-muted-foreground truncate">
                      {agent.description}
                    </p>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected}
            onClick={() => {
              if (selected) {
                onConfirm(selected);
                onOpenChange(false);
                setSelected(null);
              }
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk delete confirmation dialog
// ---------------------------------------------------------------------------

function BulkDeleteDialog({
  open,
  onOpenChange,
  count,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {count} connection{count !== 1 ? "s" : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the selected connection
            {count !== 1 ? "s" : ""}. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete {count} connection{count !== 1 ? "s" : ""}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Grouped table: renders CollectionTable-style rows with collapsible groups
// ---------------------------------------------------------------------------

function GroupedConnectionTable({
  columns,
  grouped,
  sortKey,
  sortDirection,
  onSort,
  onRowClick,
  selectionMode,
  selectedIds,
  onToggleSelect,
  emptyState,
}: {
  columns: TableColumn<ConnectionEntity>[];
  grouped: GroupedItem[];
  sortKey?: string;
  sortDirection?: "asc" | "desc" | null;
  onSort?: (key: string) => void;
  onRowClick: (connection: ConnectionEntity) => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  emptyState?: React.ReactNode;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (grouped.length === 0 && emptyState) {
    return (
      <div className="flex items-center justify-center h-full">
        {emptyState}
      </div>
    );
  }

  const colCount = columns.length;

  return (
    <div className="flex-1 overflow-auto">
      <UITable className="w-full border-collapse">
        <TableHeader className="border-b-0">
          <TableRow className="h-9 hover:bg-transparent border-b border-border">
            {columns.map((col, idx) => {
              const isActiveSort = sortKey === col.id;
              const headerBase =
                "px-4 py-2 text-left font-mono font-normal text-muted-foreground text-[11px] h-9 uppercase tracking-wider";
              const isLast = idx === colCount - 1;
              return (
                <TableHead
                  key={col.id}
                  className={cn(
                    headerBase,
                    isLast && "w-8",
                    "group transition-colors select-none",
                    col.sortable && "hover:bg-accent cursor-pointer",
                    col.cellClassName,
                  )}
                  onClick={
                    col.sortable && onSort ? () => onSort(col.id) : undefined
                  }
                >
                  <span className="flex items-center gap-1">
                    {col.header}
                    {col.sortable && (
                      <span className="w-4 flex items-center justify-center">
                        {isActiveSort &&
                          sortDirection &&
                          (sortDirection === "asc" ? (
                            <ArrowUp
                              size={16}
                              className="text-muted-foreground"
                            />
                          ) : (
                            <ArrowDown
                              size={16}
                              className="text-muted-foreground"
                            />
                          ))}
                      </span>
                    )}
                  </span>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {grouped.map((item) => {
            if (item.type === "single") {
              const c = item.connection;
              return (
                <TableRow
                  key={c.id}
                  className={cn(
                    "group/data-row transition-colors border-b-0 hover:bg-accent/50 cursor-pointer",
                    selectionMode && selectedIds.has(c.id) && "bg-primary/5",
                  )}
                  onClick={() => onRowClick(c)}
                >
                  {columns.map((col) => (
                    <TableCell
                      key={col.id}
                      className={cn(
                        "px-5 py-4 h-16 align-middle text-sm text-foreground",
                        col.cellClassName,
                      )}
                    >
                      <div className="min-w-0 w-full truncate overflow-hidden whitespace-nowrap">
                        {col.render ? col.render(c) : null}
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
              );
            }

            const group = item;
            const isExpanded = expandedGroups.has(group.key);
            const allSelected = group.connections.every((c) =>
              selectedIds.has(c.id),
            );
            const someSelected = group.connections.some((c) =>
              selectedIds.has(c.id),
            );
            const creators = getUniqueCreators(group.connections);

            const mostRecent = group.connections.reduce((latest, c) => {
              const t = c.updated_at ?? c.created_at;
              const l = latest.updated_at ?? latest.created_at;
              if (!t) return latest;
              if (!l) return c;
              return new Date(t) > new Date(l) ? c : latest;
            }, group.connections[0]!);

            return (
              <Fragment key={group.key}>
                {/* Group header row — cells align with columns */}
                <TableRow
                  className="border-b-0 hover:bg-accent/50 cursor-pointer transition-colors"
                  onClick={() => toggleGroup(group.key)}
                >
                  {columns.map((col) => {
                    const base = cn(
                      "px-5 py-3 h-14 align-middle text-sm",
                      col.cellClassName,
                    );

                    if (col.id === "select") {
                      return (
                        <TableCell key={col.id} className={base}>
                          <Checkbox
                            checked={
                              allSelected
                                ? true
                                : someSelected
                                  ? "indeterminate"
                                  : false
                            }
                            onCheckedChange={() => {
                              for (const c of group.connections) {
                                if (allSelected) {
                                  if (selectedIds.has(c.id))
                                    onToggleSelect(c.id);
                                } else {
                                  if (!selectedIds.has(c.id))
                                    onToggleSelect(c.id);
                                }
                              }
                            }}
                            onClick={(e: React.MouseEvent) =>
                              e.stopPropagation()
                            }
                          />
                        </TableCell>
                      );
                    }

                    if (col.id === "title") {
                      return (
                        <TableCell key={col.id} className={base}>
                          <div className="flex items-center gap-2 min-w-0">
                            <IntegrationIcon
                              icon={group.icon}
                              name={group.title}
                              size="sm"
                              className="shrink-0 shadow-sm"
                              fallbackIcon={<Container />}
                            />
                            <span className="text-sm font-medium text-foreground truncate">
                              {group.title}
                            </span>
                            <Badge
                              variant="secondary"
                              className="text-xs tabular-nums"
                            >
                              x{group.connections.length}
                            </Badge>
                          </div>
                        </TableCell>
                      );
                    }

                    if (col.id === "updated_by") {
                      return (
                        <TableCell key={col.id} className={base}>
                          <div className="flex items-center -space-x-1.5">
                            {creators.map((id) => (
                              <User
                                key={id}
                                id={id}
                                size="3xs"
                                avatarOnly={creators.length > 1}
                              />
                            ))}
                          </div>
                        </TableCell>
                      );
                    }

                    if (col.id === "updated_at") {
                      const ts = mostRecent.updated_at ?? mostRecent.created_at;
                      return (
                        <TableCell key={col.id} className={base}>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {ts ? formatTimeAgo(new Date(ts)) : "—"}
                          </span>
                        </TableCell>
                      );
                    }

                    if (col.id === "actions") {
                      return (
                        <TableCell key={col.id} className={base}>
                          <ChevronDown
                            size={16}
                            className={cn(
                              "text-muted-foreground transition-transform",
                              isExpanded && "rotate-180",
                            )}
                          />
                        </TableCell>
                      );
                    }

                    return <TableCell key={col.id} className={base} />;
                  })}
                </TableRow>

                {/* Expanded child rows */}
                {isExpanded &&
                  group.connections.map((c) => (
                    <TableRow
                      key={c.id}
                      className={cn(
                        "group/data-row transition-colors border-b-0 hover:bg-accent/50 cursor-pointer bg-muted/20",
                        selectionMode &&
                          selectedIds.has(c.id) &&
                          "bg-primary/5",
                      )}
                      onClick={() => onRowClick(c)}
                    >
                      {columns.map((col) => (
                        <TableCell
                          key={col.id}
                          className={cn(
                            "px-5 py-3 h-14 align-middle text-sm text-foreground",
                            col.cellClassName,
                            col.id === "title" && "pl-12",
                          )}
                        >
                          <div className="min-w-0 w-full truncate overflow-hidden whitespace-nowrap">
                            {col.render ? col.render(c) : null}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
              </Fragment>
            );
          })}
        </TableBody>
      </UITable>
    </div>
  );
}

// ===========================================================================

function OrgMcpsContent() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { action?: "create" };
  const { data: session } = authClient.useSession();
  const { stdioEnabled } = useAuthConfig();

  // Consolidated list UI state (search, filters, sorting, view mode)
  const listState = useListState<ConnectionEntity>({
    namespace: org.slug,
    resource: "connections",
  });

  const actions = useConnectionActions();
  const connections = useConnections(listState);

  const [dialogState, dispatch] = useReducer(dialogReducer, { mode: "idle" });

  // Selection / bulk-action state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [addToAgentOpen, setAddToAgentOpen] = useState(false);

  // Type & status filters
  const [typeFilter, setTypeFilter] = useState<ConnectionTypeFilter>("ALL");
  const [statusFilter, setStatusFilter] =
    useState<ConnectionStatusFilter>("ALL");

  // Agents list (for Add to Agent dialog)
  const agents = useVirtualMCPs();

  // Non-virtual connections with filters applied
  const nonVirtualConnections = connections.filter((c) => {
    if (c.connection_type === "VIRTUAL") return false;
    if (typeFilter !== "ALL" && c.connection_type !== typeFilter) return false;
    if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
    return true;
  });

  const stats = countByStatus(connections);
  const grouped = groupConnections(nonVirtualConnections);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  // Optional registry lookup: use first available registry connection as a name/description source
  const registryConnection = useRegistryConnections(connections)[0];
  const registryId = registryConnection?.id ?? "";
  const registryListToolName = findListToolName(registryConnection?.tools);
  const registryClient = useMCPClient({
    connectionId: registryId || null,
    orgId: org.id,
  });
  const { data: registryListResults } = useMCPToolCallQuery<unknown>({
    client: registryClient,
    toolName: registryListToolName,
    toolArguments: { limit: 200 },
    enabled: Boolean(registryId && registryListToolName),
    staleTime: 60 * 60 * 1000,
    select: (result) =>
      (result as { structuredContent?: unknown }).structuredContent ?? result,
  });
  const registryItems = extractItemsFromResponse<RegistryItem>(
    registryListResults ?? [],
  );

  // Create dialog state is derived from search params
  const isCreating = search.action === "create";

  const openCreateDialog = () => {
    navigate({
      to: "/$org/$project/mcps",
      params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
      search: { action: "create" },
    });
  };

  const closeCreateDialog = () => {
    navigate({
      to: "/$org/$project/mcps",
      params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
      search: {},
    });
  };

  // React Hook Form setup
  const form = useForm<ConnectionFormData>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: {
      title: "",
      description: null,
      icon: null,
      ui_type: "HTTP",
      connection_url: "",
      connection_token: null,
      npx_package: "",
      stdio_command: "",
      stdio_args: "",
      stdio_cwd: "",
      env_vars: [],
    },
  });

  // Watch the ui_type to conditionally render fields
  const uiType = form.watch("ui_type");
  const connectionUrl = form.watch("connection_url");
  const npxPackage = form.watch("npx_package");

  const providerHint =
    inferHardcodedProviderHint({
      uiType,
      connectionUrl: connectionUrl ?? "",
      npxPackage: npxPackage ?? "",
    }) ??
    inferRegistryProviderHint({
      uiType,
      connectionUrl: connectionUrl ?? "",
      registryItems,
    });

  // Reset form when editing connection changes
  const editingConnection =
    dialogState.mode === "editing" ? dialogState.connection : null;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (editingConnection) {
      // Check if it's an STDIO connection
      const stdioParams = isStdioParameters(
        editingConnection.connection_headers,
      )
        ? editingConnection.connection_headers
        : null;

      if (stdioParams && editingConnection.connection_type === "STDIO") {
        const envVars = recordToEnvVars(stdioParams.envVars);

        if (isNpxCommand(stdioParams)) {
          // NPX connection
          const npxPackage = parseStdioToNpx(stdioParams);
          form.reset({
            title: editingConnection.title,
            description: editingConnection.description,
            icon: editingConnection.icon ?? null,
            ui_type: "NPX",
            connection_url: "",
            connection_token: null,
            npx_package: npxPackage,
            stdio_command: "",
            stdio_args: "",
            stdio_cwd: "",
            env_vars: envVars,
          });
        } else {
          // Custom STDIO connection
          const customData = parseStdioToCustom(stdioParams);
          form.reset({
            title: editingConnection.title,
            description: editingConnection.description,
            icon: editingConnection.icon ?? null,
            ui_type: "STDIO",
            connection_url: "",
            connection_token: null,
            npx_package: "",
            stdio_command: customData.command,
            stdio_args: customData.args,
            stdio_cwd: customData.cwd,
            env_vars: envVars,
          });
        }
      } else {
        // HTTP/SSE/Websocket connection
        form.reset({
          title: editingConnection.title,
          description: editingConnection.description,
          icon: editingConnection.icon ?? null,
          ui_type: editingConnection.connection_type as
            | "HTTP"
            | "SSE"
            | "Websocket",
          connection_url: editingConnection.connection_url ?? "",
          connection_token: null,
          npx_package: "",
          stdio_command: "",
          stdio_args: "",
          stdio_cwd: "",
          env_vars: [],
        });
      }
    } else {
      form.reset({
        title: "",
        description: null,
        icon: null,
        ui_type: "HTTP",
        connection_url: "",
        connection_token: null,
        npx_package: "",
        stdio_command: "",
        stdio_args: "",
        stdio_cwd: "",
        env_vars: [],
      });
    }
  }, [editingConnection, form]);

  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const invalidateConnections = () => {
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        // Match collectionList/collectionItem keys: [client, scopeKey, "", "collection", collectionName, ...]
        return (
          key[1] === org.id &&
          key[3] === "collection" &&
          key[4] === "CONNECTIONS"
        );
      },
    });
  };

  // Bulk action handlers
  const handleBulkDelete = async () => {
    setBulkDeleteOpen(false);
    const ids = [...selectedIds];
    let deleted = 0;

    for (const id of ids) {
      try {
        const result = await selfClient!.callTool({
          name: "COLLECTION_CONNECTIONS_DELETE",
          arguments: { id, force: true },
        });
        if (!result.isError) deleted++;
      } catch {
        // continue with next
      }
    }

    invalidateConnections();
    toast.success(`Deleted ${deleted} connection${deleted !== 1 ? "s" : ""}`);
    exitSelectionMode();
  };

  const handleBulkToggleStatus = async (status: "active" | "inactive") => {
    const ids = [...selectedIds];
    let updated = 0;

    for (const id of ids) {
      try {
        await actions.update.mutateAsync({ id, data: { status } });
        updated++;
      } catch {
        // continue
      }
    }

    invalidateConnections();
    toast.success(
      `${status === "active" ? "Enabled" : "Disabled"} ${updated} connection${updated !== 1 ? "s" : ""}`,
    );
    exitSelectionMode();
  };

  const handleAddToAgent = async (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent || !selfClient) return;

    const existingConnIds = new Set(
      agent.connections.map((c) => c.connection_id),
    );
    const newConns = [...selectedIds]
      .filter((id) => !existingConnIds.has(id))
      .map((connection_id) => ({
        connection_id,
        selected_tools: null as string[] | null,
        selected_resources: null as string[] | null,
        selected_prompts: null as string[] | null,
      }));

    if (newConns.length === 0) {
      toast.info("All selected connections are already in that agent");
      return;
    }

    try {
      await selfClient.callTool({
        name: "COLLECTION_VIRTUAL_MCP_UPDATE",
        arguments: {
          id: agentId,
          data: {
            connections: [...agent.connections, ...newConns],
          },
        },
      });

      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          return (
            key[1] === org.id &&
            key[3] === "collection" &&
            key[4] === "VIRTUAL_MCP"
          );
        },
      });

      toast.success(
        `Added ${newConns.length} connection${newConns.length !== 1 ? "s" : ""} to "${agent.title}"`,
      );
      exitSelectionMode();
    } catch {
      toast.error("Failed to add connections to agent");
    }
  };

  /** Extract error text from an MCP tool result's content array */
  const getMcpErrorText = (result: Record<string, unknown>): string => {
    const content = result.content;
    if (
      Array.isArray(content) &&
      content[0]?.type === "text" &&
      typeof content[0].text === "string"
    ) {
      return content[0].text;
    }
    return "Unknown error";
  };

  const confirmDelete = async () => {
    if (dialogState.mode !== "deleting") return;

    const connection = dialogState.connection;
    dispatch({ type: "close" });

    try {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_DELETE",
        arguments: { id: connection.id },
      });

      if (result.isError) {
        const errorText = getMcpErrorText(result);

        // Try to parse structured error for "connection in use" case
        // The MCP error text may be prefixed with "Error: " — strip it
        const jsonText = errorText.replace(/^Error:\s*/, "");
        try {
          const parsed = JSON.parse(jsonText) as {
            code?: string;
            agentNames?: string[];
          };
          if (parsed.code === "CONNECTION_IN_USE" && parsed.agentNames) {
            dispatch({
              type: "force-delete",
              connection,
              agentNames: parsed.agentNames.map((n) => `"${n}"`).join(", "),
            });
            return;
          }
        } catch {
          // Not JSON — fall through to generic error toast
        }

        toast.error(`Failed to delete connection: ${errorText}`);
        return;
      }

      invalidateConnections();
      toast.success("Connection deleted successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to delete connection: ${message}`);
    }
  };

  const confirmForceDelete = async () => {
    if (dialogState.mode !== "force-deleting") return;

    const id = dialogState.connection.id;
    dispatch({ type: "close" });

    try {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_DELETE",
        arguments: { id, force: true },
      });

      if (result.isError) {
        toast.error(`Failed to delete connection: ${getMcpErrorText(result)}`);
        return;
      }

      invalidateConnections();
      toast.success("Connection deleted successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to delete connection: ${message}`);
    }
  };

  const onSubmit = async (data: ConnectionFormData) => {
    // Determine actual connection_type, connection_url, and connection_headers based on ui_type
    let connectionType: "HTTP" | "SSE" | "Websocket" | "STDIO";
    let connectionUrl: string | null = null;
    let connectionToken: string | null = null;
    let connectionParameters:
      | StdioConnectionParameters
      | HttpConnectionParameters
      | null = null;

    if (data.ui_type === "NPX") {
      // NPX maps to STDIO with parameters (no URL needed)
      connectionType = "STDIO";
      connectionUrl = "";
      connectionParameters = buildNpxParameters(
        data.npx_package || "",
        data.env_vars || [],
      );
    } else if (data.ui_type === "STDIO") {
      // Custom STDIO command
      connectionType = "STDIO";
      connectionUrl = "";
      connectionParameters = buildCustomStdioParameters(
        data.stdio_command || "",
        data.stdio_args || "",
        data.stdio_cwd,
        data.env_vars || [],
      );
    } else {
      connectionType = data.ui_type;
      connectionUrl = data.connection_url || "";
      connectionToken = data.connection_token || null;
    }

    if (editingConnection) {
      // Update existing connection
      await actions.update.mutateAsync({
        id: editingConnection.id,
        data: {
          title: data.title,
          description: data.description || null,
          icon: data.icon ?? null,
          connection_type: connectionType,
          connection_url: connectionUrl,
          ...(connectionToken && { connection_token: connectionToken }),
          ...(connectionParameters && {
            connection_headers: connectionParameters,
          }),
        },
      });

      dispatch({ type: "close" });
      form.reset();
      return;
    }

    const newId = generatePrefixedId("conn");
    // Create new connection
    await actions.create.mutateAsync({
      id: newId,
      title: data.title,
      description: data.description || null,
      connection_type: connectionType,
      connection_url: connectionUrl,
      connection_token: connectionToken,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: session?.user?.id || "system",
      organization_id: org.id,
      icon: data.icon ?? null,
      app_name: null,
      app_id: null,
      connection_headers: connectionParameters,
      oauth_config: null,
      configuration_state: null,
      metadata: null,
      tools: null,
      bindings: null,
      status: "inactive",
    });

    closeCreateDialog();
    form.reset();
    navigate({
      to: "/$org/$project/mcps/$connectionId",
      params: {
        org: org.slug,
        project: ORG_ADMIN_PROJECT_SLUG,
        connectionId: newId,
      },
    });
  };

  const handleDialogClose = (open: boolean) => {
    if (!open) {
      if (isCreating) {
        closeCreateDialog();
      } else {
        dispatch({ type: "close" });
      }
      form.reset();
    }
  };

  const applyInferenceFromInput = (rawInput: string) => {
    const raw = rawInput.trim();
    if (!raw) return;

    const titleIsDirty = Boolean(form.formState.dirtyFields.title);
    const descriptionIsDirty = Boolean(form.formState.dirtyFields.description);
    const envVarsIsDirty = Boolean(form.formState.dirtyFields.env_vars);

    const applySuggestedMeta = (hint: ConnectionProviderHint | null) => {
      if (!hint) return;

      if (!titleIsDirty && !form.getValues("title").trim() && hint.title) {
        form.setValue("title", hint.title, { shouldDirty: false });
      }

      if (
        !descriptionIsDirty &&
        !(form.getValues("description") ?? "").trim() &&
        hint.description
      ) {
        form.setValue("description", hint.description, { shouldDirty: false });
      }

      if (!envVarsIsDirty && hint.envVarKeys?.length) {
        const current = form.getValues("env_vars") ?? [];
        const existingKeys = new Set(current.map((v) => v.key));
        const toAdd = hint.envVarKeys.filter((k) => !existingKeys.has(k));
        if (toAdd.length > 0) {
          form.setValue(
            "env_vars",
            [...current, ...toAdd.map((key) => ({ key, value: "" }))],
            { shouldDirty: true },
          );
        }
      }
    };

    const npx = parseNpxLikeCommand(raw);
    if (npx && stdioEnabled) {
      form.setValue("ui_type", "NPX", { shouldDirty: true });
      form.setValue("npx_package", npx.packageName, { shouldDirty: true });
      // Clear HTTP fields for clarity
      form.setValue("connection_url", "", { shouldDirty: true });
      form.setValue("connection_token", null, { shouldDirty: true });

      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: "NPX",
          npxPackage: npx.packageName,
        }),
      );
      return;
    }

    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const nextUiType =
        uiType === "HTTP" || uiType === "SSE" || uiType === "Websocket"
          ? uiType
          : "HTTP";
      form.setValue("ui_type", nextUiType, { shouldDirty: true });
      form.setValue("connection_url", raw, { shouldDirty: true });

      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: nextUiType,
          connectionUrl: raw,
        }) ??
          inferRegistryProviderHint({
            uiType: nextUiType,
            connectionUrl: raw,
            registryItems,
          }),
      );
      return;
    }

    // NPX package typed directly (no "npx" prefix)
    if (uiType === "NPX") {
      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: "NPX",
          npxPackage: raw,
        }),
      );
    }
  };

  const columns: TableColumn<ConnectionEntity>[] = [
    ...(selectionMode
      ? [
          {
            id: "select",
            header: "",
            render: (connection: ConnectionEntity) => (
              <Checkbox
                checked={selectedIds.has(connection.id)}
                onCheckedChange={() => toggleSelect(connection.id)}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              />
            ),
            cellClassName: "w-10 shrink-0",
          } satisfies TableColumn<ConnectionEntity>,
        ]
      : []),
    {
      id: "title",
      header: "Name",
      render: (connection) => (
        <div className="flex items-center gap-2 min-w-0">
          <IntegrationIcon
            icon={connection.icon}
            name={connection.title}
            size="sm"
            className="shrink-0 shadow-sm"
            fallbackIcon={<Container />}
          />
          <span
            className="text-sm font-medium text-foreground truncate block"
            title={connection.title}
          >
            {connection.title}
          </span>
        </div>
      ),
      cellClassName: "w-32 min-w-0 shrink-0",
      sortable: true,
    },
    {
      id: "description",
      header: "Description",
      render: (connection) => (
        <span
          className="text-sm text-muted-foreground truncate block"
          title={connection.description || ""}
        >
          {connection.description || "—"}
        </span>
      ),
      cellClassName: "flex-1 min-w-0 max-w-0",
      wrap: false,
      sortable: true,
    },
    {
      id: "connection_type",
      header: "Type",
      accessor: (connection) => (
        <span className="text-xs font-medium">
          {connection.connection_type}
        </span>
      ),
      cellClassName: "w-16 shrink-0",
      sortable: true,
    },
    {
      id: "status",
      header: "Status",
      render: (connection) => (
        <ConnectionStatus
          status={connection.status}
          needsAuth={connectionNeedsAuth(connection)}
        />
      ),
      cellClassName: "w-28 shrink-0",
      sortable: false,
    },
    {
      id: "updated_by",
      header: "Updated by",
      render: (connection) => (
        <User id={connection.updated_by ?? connection.created_by} size="3xs" />
      ),
      cellClassName: "w-32 shrink-0",
      sortable: true,
    },
    {
      id: "updated_at",
      header: "Updated",
      render: (connection) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {connection.updated_at
            ? formatTimeAgo(new Date(connection.updated_at))
            : "—"}
        </span>
      ),
      cellClassName: "max-w-24 w-24 shrink-0",
      sortable: true,
    },
    {
      id: "actions",
      header: "",
      render: (connection) => (
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
                  to: "/$org/$project/mcps/$connectionId",
                  params: {
                    org: org.slug,
                    project: ORG_ADMIN_PROJECT_SLUG,
                    connectionId: connection.id,
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
                dispatch({ type: "delete", connection });
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
    <div className="flex items-center gap-2">
      {selectionMode ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 rounded-lg text-sm font-medium"
          onClick={exitSelectionMode}
        >
          <XClose size={14} />
          Cancel
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 rounded-lg text-sm font-medium"
            onClick={() => setSelectionMode(true)}
          >
            <CheckSquare size={14} />
            Select
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              navigate({
                to: "/$org/$project/store",
                params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
              })
            }
            size="sm"
            className="h-7 px-3 rounded-lg text-sm font-medium"
          >
            Browse Store
          </Button>
          <Button
            onClick={openCreateDialog}
            size="sm"
            className="h-7 px-3 rounded-lg text-sm font-medium"
          >
            Custom Connection
          </Button>
        </>
      )}
    </div>
  );

  return (
    <Page>
      <Dialog
        open={isCreating || dialogState.mode === "editing"}
        onOpenChange={handleDialogClose}
      >
        <DialogContent className="sm:max-w-[525px]">
          <DialogHeader>
            <DialogTitle>
              {editingConnection ? "Edit Connection" : "Create Connection"}
            </DialogTitle>
            <DialogDescription>
              {editingConnection
                ? "Update the connection details below."
                : "Create a custom connection in your organization. Fill in the details below."}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <div className="grid gap-4 py-4">
                <FormField
                  control={form.control}
                  name="ui_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type *</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="HTTP">
                            <span className="flex items-center gap-2">
                              <Globe02 className="w-4 h-4" />
                              HTTP
                            </span>
                          </SelectItem>
                          <SelectItem value="SSE">
                            <span className="flex items-center gap-2">
                              <Globe02 className="w-4 h-4" />
                              SSE
                            </span>
                          </SelectItem>
                          <SelectItem value="Websocket">
                            <span className="flex items-center gap-2">
                              <Globe02 className="w-4 h-4" />
                              Websocket
                            </span>
                          </SelectItem>
                          {stdioEnabled && (
                            <>
                              <SelectItem value="NPX">
                                <span className="flex items-center gap-2">
                                  <Container className="w-4 h-4" />
                                  NPX Package
                                </span>
                              </SelectItem>
                              <SelectItem value="STDIO">
                                <span className="flex items-center gap-2">
                                  <Terminal className="w-4 h-4" />
                                  Custom Command
                                </span>
                              </SelectItem>
                            </>
                          )}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* NPX-specific fields */}
                {uiType === "NPX" && (
                  <>
                    <FormField
                      control={form.control}
                      name="npx_package"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>NPM Package *</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="@perplexity-ai/mcp-server"
                              {...field}
                              value={field.value ?? ""}
                              onPaste={(e) => {
                                const pasted = e.clipboardData.getData("text");
                                if (!pasted) return;
                                e.preventDefault();
                                form.setValue("npx_package", pasted.trim(), {
                                  shouldDirty: true,
                                });
                                applyInferenceFromInput(pasted);
                              }}
                              onBlur={(e) => {
                                applyInferenceFromInput(e.target.value);
                                field.onBlur();
                              }}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}

                {/* STDIO/Custom Command fields */}
                {uiType === "STDIO" && (
                  <>
                    <div className="grid grid-cols-2 gap-4 items-start">
                      <FormField
                        control={form.control}
                        name="stdio_command"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Command *</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="node, bun, python..."
                                {...field}
                                value={field.value ?? ""}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="stdio_args"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Arguments</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="arg1 arg2 --flag value"
                                {...field}
                                value={field.value ?? ""}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name="stdio_cwd"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Working Directory</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="/path/to/project (optional)"
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <p className="text-xs text-muted-foreground">
                            Directory where the command will be executed
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}

                {/* Shared: Environment Variables for NPX and STDIO */}
                {(uiType === "NPX" || uiType === "STDIO") && (
                  <FormField
                    control={form.control}
                    name="env_vars"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Environment Variables</FormLabel>
                        <FormControl>
                          <EnvVarsEditor
                            value={field.value ?? []}
                            onChange={field.onChange}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {/* HTTP/SSE/Websocket fields */}
                {uiType !== "NPX" && uiType !== "STDIO" && (
                  <>
                    <FormField
                      control={form.control}
                      name="connection_url"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>URL *</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="https://example.com/mcp"
                              {...field}
                              value={field.value ?? ""}
                              onPaste={(e) => {
                                const pasted = e.clipboardData.getData("text");
                                if (!pasted) return;
                                e.preventDefault();
                                form.setValue("connection_url", pasted.trim(), {
                                  shouldDirty: true,
                                });
                                applyInferenceFromInput(pasted);
                              }}
                              onBlur={(e) => {
                                applyInferenceFromInput(e.target.value);
                                field.onBlur();
                              }}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="connection_token"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {providerHint?.token?.label ?? "Token (optional)"}
                          </FormLabel>
                          <FormControl>
                            <Input
                              type="password"
                              placeholder={
                                providerHint?.token?.placeholder ??
                                "Bearer token or API key"
                              }
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          {providerHint?.token?.helperText && (
                            <p className="text-xs text-muted-foreground">
                              {providerHint.token.helperText}
                              {providerHint.id === "github" && (
                                <>
                                  {" "}
                                  ·{" "}
                                  <a
                                    className="text-foreground underline underline-offset-4 hover:text-foreground/80"
                                    href="https://github.com/settings/personal-access-tokens"
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open GitHub PAT settings
                                  </a>
                                </>
                              )}
                            </p>
                          )}
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}

                {/* Name/description come after connection mode/inputs so we can infer them */}
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="My Connection" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="A brief description of this connection"
                          rows={3}
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleDialogClose(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={form.formState.isSubmitting}
                  className="min-w-40"
                >
                  {form.formState.isSubmitting
                    ? "Saving..."
                    : editingConnection
                      ? "Update Connection"
                      : "Create Connection"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={dialogState.mode === "deleting"}
        onOpenChange={(open) => !open && dispatch({ type: "close" })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Connection?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {dialogState.mode === "deleting" &&
                  dialogState.connection.title}
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

      {/* Force Delete Confirmation Dialog */}
      <AlertDialog
        open={dialogState.mode === "force-deleting"}
        onOpenChange={(open) => !open && dispatch({ type: "close" })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Connection Used by Agents</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  The connection{" "}
                  <span className="font-medium text-foreground">
                    {dialogState.mode === "force-deleting" &&
                      dialogState.connection.title}
                  </span>{" "}
                  is currently used by the following agent(s):{" "}
                  <span className="font-medium text-foreground">
                    {dialogState.mode === "force-deleting" &&
                      dialogState.agentNames}
                  </span>
                  .
                </p>
                <p className="mt-2">
                  Deleting this connection will remove it from those agents,
                  which may impact existing workflows that depend on them.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmForceDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk action dialogs */}
      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        count={selectedIds.size}
        onConfirm={handleBulkDelete}
      />
      <AddToAgentDialog
        open={addToAgentOpen}
        onOpenChange={setAddToAgentOpen}
        agents={agents}
        onConfirm={handleAddToAgent}
      />

      {/* Page Header */}
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="flex items-center gap-2">
                  Connections
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {stats.total} total
                    {stats.active > 0 && ` · ${stats.active} active`}
                    {stats.error > 0 && ` · ${stats.error} errors`}
                  </span>
                </BreadcrumbPage>
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
              { id: "connection_type", label: "Type" },
              { id: "updated_by", label: "Updated by" },
              { id: "updated_at", label: "Updated" },
            ]}
            filters={[
              {
                label: "Type",
                value: typeFilter,
                onChange: (v) =>
                  setTypeFilter((v as ConnectionTypeFilter) || "ALL"),
                options: [
                  { id: "ALL", label: "All" },
                  { id: "HTTP", label: "HTTP" },
                  { id: "SSE", label: "SSE" },
                  { id: "Websocket", label: "WebSocket" },
                  { id: "STDIO", label: "STDIO" },
                ],
              },
              {
                label: "Status",
                value: statusFilter,
                onChange: (v) =>
                  setStatusFilter((v as ConnectionStatusFilter) || "ALL"),
                options: [
                  { id: "ALL", label: "All" },
                  { id: "active", label: "Active" },
                  { id: "inactive", label: "Inactive" },
                  { id: "error", label: "Error" },
                ],
              },
            ]}
          />
          {ctaButton}
        </Page.Header.Right>
      </Page.Header>

      {/* Search */}
      <div className="flex items-center gap-3 px-5 pb-0">
        <div className="flex-1">
          <CollectionSearch
            value={listState.search}
            onChange={listState.setSearch}
            placeholder="Search for a Connection..."
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                listState.setSearch("");
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
      </div>

      {/* Content: Cards or Table */}
      <Page.Content>
        {listState.viewMode === "cards" ? (
          <div className="flex-1 overflow-auto p-5">
            {nonVirtualConnections.length === 0 ? (
              <EmptyState
                image={
                  <img
                    src="/emptystate-mcp.svg"
                    alt=""
                    width={336}
                    height={320}
                    aria-hidden="true"
                  />
                }
                title="No Connections found"
                description={
                  listState.search
                    ? `No Connections match "${listState.search}"`
                    : "Create a connection to get started."
                }
                actions={
                  !listState.search && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        navigate({
                          to: "/$org/$project/store",
                          params: {
                            org: org.slug,
                            project: ORG_ADMIN_PROJECT_SLUG,
                          },
                        })
                      }
                    >
                      Browse Store
                    </Button>
                  )
                }
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {grouped.map((item) => {
                  if (item.type === "group") {
                    return (
                      <ConnectionGroupCard
                        key={item.key}
                        group={item}
                        onNavigate={(id) =>
                          navigate({
                            to: "/$org/$project/mcps/$connectionId",
                            params: {
                              org: org.slug,
                              project: ORG_ADMIN_PROJECT_SLUG,
                              connectionId: id,
                            },
                          })
                        }
                        onDelete={(c) =>
                          dispatch({ type: "delete", connection: c })
                        }
                        selectionMode={selectionMode}
                        selectedIds={selectedIds}
                        onToggleSelect={toggleSelect}
                      />
                    );
                  }

                  const connection = item.connection;
                  return (
                    <div key={connection.id} className="relative">
                      {selectionMode && (
                        <div className="absolute top-3 left-3 z-10">
                          <Checkbox
                            checked={selectedIds.has(connection.id)}
                            onCheckedChange={() => toggleSelect(connection.id)}
                          />
                        </div>
                      )}
                      <ConnectionCard
                        connection={connection}
                        fallbackIcon={<Container />}
                        onClick={() =>
                          selectionMode
                            ? toggleSelect(connection.id)
                            : navigate({
                                to: "/$org/$project/mcps/$connectionId",
                                params: {
                                  org: org.slug,
                                  project: ORG_ADMIN_PROJECT_SLUG,
                                  connectionId: connection.id,
                                },
                              })
                        }
                        className={cn(
                          selectionMode &&
                            selectedIds.has(connection.id) &&
                            "ring-2 ring-primary",
                        )}
                        headerActions={
                          !selectionMode ? (
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
                                      to: "/$org/$project/mcps/$connectionId",
                                      params: {
                                        org: org.slug,
                                        project: ORG_ADMIN_PROJECT_SLUG,
                                        connectionId: connection.id,
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
                                    dispatch({ type: "delete", connection });
                                  }}
                                >
                                  <Trash01 size={16} />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : undefined
                        }
                        body={
                          <ConnectionStatus
                            status={connection.status}
                            needsAuth={connectionNeedsAuth(connection)}
                          />
                        }
                        footer={
                          <div className="flex items-center justify-between text-xs text-muted-foreground w-full min-w-0">
                            <div className="flex-1 min-w-0">
                              <User
                                id={
                                  connection.updated_by ?? connection.created_by
                                }
                                size="3xs"
                              />
                            </div>
                            <span className="shrink-0 ml-2">
                              {connection.updated_at
                                ? formatTimeAgo(new Date(connection.updated_at))
                                : "—"}
                            </span>
                          </div>
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto min-w-0">
              <div className="min-w-[1000px]">
                <GroupedConnectionTable
                  columns={columns}
                  grouped={grouped}
                  sortKey={listState.sortKey}
                  sortDirection={listState.sortDirection}
                  onSort={listState.handleSort}
                  onRowClick={(connection) =>
                    selectionMode
                      ? toggleSelect(connection.id)
                      : navigate({
                          to: "/$org/$project/mcps/$connectionId",
                          params: {
                            org: org.slug,
                            project: ORG_ADMIN_PROJECT_SLUG,
                            connectionId: connection.id,
                          },
                        })
                  }
                  selectionMode={selectionMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  emptyState={
                    listState.search ? (
                      <EmptyState
                        image={
                          <img
                            src="/emptystate-mcp.svg"
                            alt=""
                            width={400}
                            height={178}
                            aria-hidden="true"
                          />
                        }
                        title="No Connections found"
                        description={`No Connections match "${listState.search}"`}
                      />
                    ) : (
                      <EmptyState
                        image={
                          <img
                            src="/emptystate-mcp.svg"
                            alt=""
                            width={400}
                            height={178}
                            aria-hidden="true"
                          />
                        }
                        title="No Connections found"
                        description="Create a connection to get started."
                        actions={
                          <Button
                            variant="outline"
                            onClick={() =>
                              navigate({
                                to: "/$org/$project/store",
                                params: {
                                  org: org.slug,
                                  project: ORG_ADMIN_PROJECT_SLUG,
                                },
                              })
                            }
                          >
                            Browse Store
                          </Button>
                        }
                      />
                    )
                  }
                />
              </div>
            </div>
          </div>
        )}
      </Page.Content>

      {/* Floating bulk action bar */}
      {selectionMode && (
        <BulkActionBar
          count={selectedIds.size}
          total={nonVirtualConnections.length}
          onSelectAll={() => {
            setSelectedIds(new Set(nonVirtualConnections.map((c) => c.id)));
          }}
          onDeselectAll={() => setSelectedIds(new Set())}
          onDelete={() => setBulkDeleteOpen(true)}
          onAddToAgent={() => setAddToAgentOpen(true)}
          onToggleStatus={handleBulkToggleStatus}
          onCancel={exitSelectionMode}
        />
      )}
    </Page>
  );
}

export default function OrgMcps() {
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
        <OrgMcpsContent />
      </Suspense>
    </ErrorBoundary>
  );
}

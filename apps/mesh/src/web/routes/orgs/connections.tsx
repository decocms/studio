import { generatePrefixedId } from "@/shared/utils/generate-id";
import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import { type TableColumn } from "@/web/components/collections/collection-table.tsx";
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
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
import {
  ORG_ADMIN_PROJECT_SLUG,
  SELF_MCP_ALIAS_ID,
  useConnectionActions,
  useConnections,
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Container,
  DotsVertical,
  Eye,
  Globe02,
  Loading01,
  Terminal,
  Trash01,
} from "@untitledui/icons";
import { Suspense, useEffect, useReducer } from "react";
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
      icon: null,
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
      render: (connection) => <ConnectionStatus status={connection.status} />,
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

      {/* Page Header */}
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Connections</BreadcrumbPage>
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
          />
          {ctaButton}
        </Page.Header.Right>
      </Page.Header>

      {/* Search Bar */}
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

      {/* Content: Cards or Table */}
      <Page.Content>
        {listState.viewMode === "cards" ? (
          <div className="flex-1 overflow-auto p-5">
            {connections.length === 0 ? (
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
                title={
                  listState.search
                    ? "No Connections found"
                    : "No Connections found"
                }
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
                {connections.map((connection) => (
                  <ConnectionCard
                    key={connection.id}
                    connection={connection}
                    fallbackIcon={<Container />}
                    onClick={() =>
                      navigate({
                        to: "/$org/$project/mcps/$connectionId",
                        params: {
                          org: org.slug,
                          project: ORG_ADMIN_PROJECT_SLUG,
                          connectionId: connection.id,
                        },
                      })
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
                    }
                    body={<ConnectionStatus status={connection.status} />}
                    footer={
                      <div className="flex items-center justify-between text-xs text-muted-foreground w-full min-w-0">
                        <div className="flex-1 min-w-0">
                          <User
                            id={connection.updated_by ?? connection.created_by}
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
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto min-w-0">
              <div className="min-w-[1000px]">
                <CollectionTableWrapper
                  columns={columns}
                  data={connections}
                  isLoading={false}
                  sortKey={listState.sortKey}
                  sortDirection={listState.sortDirection}
                  onSort={listState.handleSort}
                  onRowClick={(connection) =>
                    navigate({
                      to: "/$org/$project/mcps/$connectionId",
                      params: {
                        org: org.slug,
                        project: ORG_ADMIN_PROJECT_SLUG,
                        connectionId: connection.id,
                      },
                    })
                  }
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

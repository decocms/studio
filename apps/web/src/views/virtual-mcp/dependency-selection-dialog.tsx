import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { ToolAnnotationBadges } from "@/components/tools";
import { ErrorBoundary } from "@/components/error-boundary";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { useMCPAuthStatus } from "@/hooks/use-mcp-auth-status";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@deco/ui/components/dialog.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  useConnection,
  useMCPClient,
  useMCPPromptsList,
  useMCPResourcesList,
  useMCPToolsList,
  useProjectContext,
} from "@/sdk";
import { AlertTriangle, Loading01, LockUnlocked01 } from "@untitledui/icons";
import type { ReactNode } from "react";
import { Suspense, useReducer } from "react";
import type { VirtualMCPConnection } from "@decocms/shared/sdk/types";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  type ConnectionFormValue,
  type SelectionValue,
} from "./selection-utils";
import type { VirtualMcpFormReturn } from "./types";

// Form types
type FormData = Record<string, ConnectionFormValue>;

// Generic item type for selections
interface SelectableItem {
  id: string;
  name: string;
  description?: string;
  tags?: ReactNode;
}

// Loading spinner component
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-32">
      <Loading01 className="animate-spin text-muted-foreground" size={24} />
    </div>
  );
}

// Error fallback factory for method not found errors
// Receives t as an argument: the returned function is an ErrorBoundary render
// callback, not a component, so it must not call hooks itself.
function createMethodNotFoundFallback(
  notSupportedMessage: string,
  t: TFunction,
) {
  return ({ error }: { error: Error | null }) => {
    // Check for "Method not found" error (code -32601)
    const isMethodNotFound =
      error?.message?.includes("Method not found") ||
      (error as { code?: number } | null)?.code === -32601;

    if (isMethodNotFound) {
      return (
        <div className="flex-1 overflow-auto px-4 py-3 space-y-1">
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            {notSupportedMessage}
          </div>
        </div>
      );
    }

    // Default error fallback
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full p-6 text-center space-y-4">
        <div className="bg-destructive/10 p-3 rounded-full">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">
            {t("virtualMcp.dependencySelectionDialog.somethingWentWrong")}
          </h3>
          <p className="text-sm text-muted-foreground max-w-xs mx-auto">
            {error?.message
              ? error.message.length > 200
                ? `${error.message.slice(0, 200)}...`
                : error.message
              : t("virtualMcp.dependencySelectionDialog.unexpectedError")}
          </p>
        </div>
      </div>
    );
  };
}

// Generic Selection Item Component
function SelectionItem({
  item,
  isSelected,
  onToggle,
  disabled,
}: {
  item: SelectableItem;
  isSelected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 p-4 rounded-lg transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        isSelected ? "bg-accent/25" : "hover:bg-muted/50",
      )}
    >
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium leading-none truncate">
            {item.name}
          </p>
          {item.tags && <span className="shrink-0">{item.tags}</span>}
        </div>
        {item.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {item.description}
          </p>
        )}
      </div>
      <Checkbox
        checked={isSelected}
        onCheckedChange={onToggle}
        disabled={disabled}
        className="mt-0.5"
      />
    </label>
  );
}

// Helper component for tabs row
function ConnectionDetailsContentTabs({
  activeTab,
  onTabChange,
  showSelectAll,
  isAllSelected,
  handleSelectAll,
}: {
  activeTab: TabId;
  onTabChange: (value: TabId) => void;
  showSelectAll: boolean;
  isAllSelected: boolean;
  handleSelectAll: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-between px-6 py-3 border-t border-border shrink-0">
      <CollectionTabs
        tabs={[
          {
            id: "tools",
            label: t("virtualMcp.dependencySelectionDialog.tabTools"),
          },
          {
            id: "active",
            label: t("virtualMcp.dependencySelectionDialog.tabActive"),
          },
          {
            id: "resources",
            label: t("virtualMcp.dependencySelectionDialog.tabResources"),
          },
          {
            id: "prompts",
            label: t("virtualMcp.dependencySelectionDialog.tabPrompts"),
          },
        ]}
        activeTab={activeTab}
        onTabChange={(id) => onTabChange(id as TabId)}
      />
      {showSelectAll && (
        <button
          type="button"
          onClick={handleSelectAll}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {isAllSelected
            ? t("virtualMcp.dependencySelectionDialog.deselectAll")
            : t("virtualMcp.dependencySelectionDialog.selectAll")}
        </button>
      )}
    </div>
  );
}

// Generic Selection Tab Component
function SelectionTab({
  items,
  selections,
  onToggle,
  emptyMessage,
  disabled,
}: {
  items: SelectableItem[];
  selections: SelectionValue;
  onToggle: (itemId: string, allItemIds: string[]) => void;
  emptyMessage: string;
  disabled?: boolean;
}) {
  const allItemIds = items.map((item) => item.id);

  // Early return for empty state
  if (items.length === 0) {
    return (
      <div className="flex-1 overflow-auto px-4 py-3 space-y-1">
        <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-4 py-3 space-y-1">
      {items.map((item) => (
        <SelectionItem
          key={item.id}
          item={item}
          isSelected={selections === null || selections?.includes(item.id)}
          onToggle={() => onToggle(item.id, allItemIds)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

// Active Tab — shows only selected tools
function ActiveToolsTab({
  connectionId,
  toolSelections,
  onToggleTool,
}: {
  connectionId: string;
  toolSelections: SelectionValue;
  onToggleTool: (toolName: string, allToolNames: string[]) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data } = useMCPToolsList({ client });

  const allToolNames = data.tools.map((t) => t.name);

  const activeTools = data.tools.filter(
    (tool) => toolSelections === null || toolSelections.includes(tool.name),
  );

  const items: SelectableItem[] = activeTools.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description,
    tags: (
      <ToolAnnotationBadges
        annotations={tool.annotations}
        _meta={tool._meta as Record<string, unknown> | undefined}
      />
    ),
  }));

  if (items.length === 0) {
    return (
      <div className="flex-1 overflow-auto px-4 py-3 space-y-1">
        <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
          {t("virtualMcp.dependencySelectionDialog.noActiveToolsSelected")}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-4 py-3 space-y-1">
      {items.map((item) => (
        <SelectionItem
          key={item.id}
          item={item}
          isSelected={true}
          onToggle={() => onToggleTool(item.id, allToolNames)}
        />
      ))}
    </div>
  );
}

// Tools Tab Wrapper
function ToolsTab({
  connectionId,
  selections,
  onToggle,
  disabled,
}: {
  connectionId: string;
  selections: SelectionValue;
  onToggle: (toolName: string, allToolNames: string[]) => void;
  disabled?: boolean;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data } = useMCPToolsList({ client });

  const items: SelectableItem[] = data.tools.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description,
    tags: (
      <ToolAnnotationBadges
        annotations={tool.annotations}
        _meta={tool._meta as Record<string, unknown> | undefined}
      />
    ),
  }));

  const t = useT();
  return (
    <SelectionTab
      items={items}
      selections={selections}
      onToggle={onToggle}
      emptyMessage={t("virtualMcp.dependencySelectionDialog.noToolsAvailable")}
      disabled={disabled}
    />
  );
}

// Resources Tab Wrapper
function ResourcesTab({
  connectionId,
  selections,
  onToggle,
  disabled,
}: {
  connectionId: string;
  selections: SelectionValue;
  onToggle: (name: string, allResourceNames: string[]) => void;
  disabled?: boolean;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data } = useMCPResourcesList({ client });

  const items: SelectableItem[] = data.resources.map((resource) => ({
    id: resource.name || resource.uri,
    name: resource.name || resource.uri,
    description: resource.description,
  }));

  const t = useT();
  return (
    <SelectionTab
      items={items}
      selections={selections}
      onToggle={onToggle}
      emptyMessage={t(
        "virtualMcp.dependencySelectionDialog.noResourcesAvailable",
      )}
      disabled={disabled}
    />
  );
}

// Prompts Tab Wrapper
function PromptsTab({
  connectionId,
  selections,
  onToggle,
  disabled,
}: {
  connectionId: string;
  selections: SelectionValue;
  onToggle: (name: string, allPromptNames: string[]) => void;
  disabled?: boolean;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data } = useMCPPromptsList({ client });

  const items: SelectableItem[] = data.prompts.map((prompt) => ({
    id: prompt.name,
    name: prompt.name,
    description: prompt.description,
  }));

  const t = useT();
  return (
    <SelectionTab
      items={items}
      selections={selections}
      onToggle={onToggle}
      emptyMessage={t(
        "virtualMcp.dependencySelectionDialog.noPromptsAvailable",
      )}
      disabled={disabled}
    />
  );
}

type TabId = "active" | "tools" | "resources" | "prompts";

// Connection Details Content Component
function ConnectionDetailsContent({
  currentConnection,
  activeTab,
  selectedId,
  formData,
  toggleTool,
  toggleResource,
  togglePrompt,
  toggleAllTools,
  toggleAllResources,
  toggleAllPrompts,
  onTabChange,
}: {
  currentConnection: {
    id: string;
    title: string;
    description?: string | null;
    icon?: string | null;
  };
  activeTab: TabId;
  selectedId: string;
  formData: FormData;
  toggleTool: (
    connId: string,
    toolName: string,
    allToolNames: string[],
  ) => void;
  toggleResource: (
    connId: string,
    name: string,
    allResourceNames: string[],
  ) => void;
  togglePrompt: (
    connId: string,
    name: string,
    allPromptNames: string[],
  ) => void;
  toggleAllTools: (connId: string) => void;
  toggleAllResources: (connId: string) => void;
  toggleAllPrompts: (connId: string) => void;
  onTabChange: (value: TabId) => void;
}) {
  const t = useT();
  const sel = formData[selectedId];
  const isAllSelected =
    activeTab === "tools"
      ? sel?.tools === null
      : activeTab === "resources"
        ? sel?.resources === null
        : activeTab === "prompts"
          ? sel?.prompts === null
          : false;

  const showSelectAll = activeTab !== "active";

  const handleSelectAll = () => {
    if (activeTab === "tools") toggleAllTools(selectedId);
    else if (activeTab === "resources") toggleAllResources(selectedId);
    else if (activeTab === "prompts") toggleAllPrompts(selectedId);
  };

  return (
    <>
      {/* Header */}
      <div className="px-6 pt-5 pb-4 shrink-0">
        <div className="flex items-center gap-3">
          <IntegrationIcon
            icon={currentConnection.icon}
            name={currentConnection.title}
            size="sm"
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold truncate">
              {currentConnection.title}
            </h2>
            {currentConnection.description && (
              <p className="text-xs text-muted-foreground truncate">
                {currentConnection.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Tabs row + Select all */}
      <ConnectionDetailsContentTabs
        activeTab={activeTab}
        onTabChange={onTabChange}
        showSelectAll={showSelectAll}
        isAllSelected={isAllSelected}
        handleSelectAll={handleSelectAll}
      />

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === "active" && (
          <ErrorBoundary
            fallback={createMethodNotFoundFallback(
              t("virtualMcp.dependencySelectionDialog.toolsNotSupported"),
              t,
            )}
          >
            <Suspense fallback={<LoadingSpinner />}>
              <ActiveToolsTab
                connectionId={selectedId}
                toolSelections={
                  formData[selectedId] ? formData[selectedId]!.tools : []
                }
                onToggleTool={(toolName, allToolNames) =>
                  toggleTool(selectedId, toolName, allToolNames)
                }
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {activeTab === "tools" && (
          <ErrorBoundary
            fallback={createMethodNotFoundFallback(
              t("virtualMcp.dependencySelectionDialog.toolsNotSupported"),
              t,
            )}
          >
            <Suspense fallback={<LoadingSpinner />}>
              <ToolsTab
                connectionId={selectedId}
                selections={
                  // IMPORTANT: Do NOT use ?? here!
                  // null means "all selected" (must be preserved)
                  formData[selectedId] ? formData[selectedId]!.tools : []
                }
                onToggle={(toolName, allToolNames) =>
                  toggleTool(selectedId, toolName, allToolNames)
                }
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {activeTab === "resources" && (
          <ErrorBoundary
            fallback={createMethodNotFoundFallback(
              t("virtualMcp.dependencySelectionDialog.resourcesNotSupported"),
              t,
            )}
          >
            <Suspense fallback={<LoadingSpinner />}>
              <ResourcesTab
                connectionId={selectedId}
                selections={
                  formData[selectedId] ? formData[selectedId]!.resources : []
                }
                onToggle={(name, allResourceNames) =>
                  toggleResource(selectedId, name, allResourceNames)
                }
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {activeTab === "prompts" && (
          <ErrorBoundary
            fallback={createMethodNotFoundFallback(
              t("virtualMcp.dependencySelectionDialog.promptsNotSupported"),
              t,
            )}
          >
            <Suspense fallback={<LoadingSpinner />}>
              <PromptsTab
                connectionId={selectedId}
                selections={
                  formData[selectedId] ? formData[selectedId]!.prompts : []
                }
                onToggle={(name, allPromptNames) =>
                  togglePrompt(selectedId, name, allPromptNames)
                }
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
    </>
  );
}

interface DependencySelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedId: string | null;
  form: VirtualMcpFormReturn;
  connections: VirtualMCPConnection[];
  onAuthenticate?: (connectionId: string) => void;
}

// Dialog footer component
function DialogFooterComponent({
  onClose,
}: {
  onClose: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <DialogFooter className="px-6 py-4 border-t border-border shrink-0">
      <Button variant="outline" onClick={() => onClose(false)}>
        {t("virtualMcp.dependencySelectionDialog.done")}
      </Button>
    </DialogFooter>
  );
}

// Auth check — renders auth prompt if the connection needs authorization
function AuthGate({
  connectionId,
  onAuthenticate,
  children,
}: {
  connectionId: string;
  onAuthenticate?: (connectionId: string) => void;
  children: ReactNode;
}) {
  const t = useT();
  const authStatus = useMCPAuthStatus({ connectionId });
  const needsAuth = authStatus.supportsOAuth && !authStatus.isAuthenticated;

  if (needsAuth) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex items-center justify-center size-12 rounded-full bg-muted">
          <LockUnlocked01 size={22} className="text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t("virtualMcp.dependencySelectionDialog.authorizationRequired")}
          </p>
          <p className="text-xs text-muted-foreground max-w-xs">
            {t("virtualMcp.dependencySelectionDialog.authorizationDescription")}
          </p>
        </div>
        {onAuthenticate && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAuthenticate(connectionId)}
          >
            {t("virtualMcp.dependencySelectionDialog.authorize")}
          </Button>
        )}
      </div>
    );
  }

  return <>{children}</>;
}

// Helper: Convert connections array to Record for easier manipulation
function connectionsToRecord(connections: VirtualMCPConnection[]): FormData {
  const formData: FormData = {};
  for (const conn of connections) {
    formData[conn.connection_id] = {
      tools: conn.selected_tools,
      resources: conn.selected_resources ?? null,
      prompts: conn.selected_prompts ?? null,
    };
  }
  return formData;
}

// Helper: Convert Record back to connections array
function recordToConnections(formData: FormData): VirtualMCPConnection[] {
  return Object.entries(formData).map(([connId, sel]) => ({
    connection_id: connId,
    selected_tools: sel.tools,
    selected_resources: sel.resources,
    selected_prompts: sel.prompts,
  }));
}

// Helper: Set a single field's selection for a connection, initializing the
// entry (all fields null) if it doesn't exist yet.
function withFieldValue(
  formData: FormData,
  connId: string,
  field: "tools" | "resources" | "prompts",
  value: SelectionValue,
): FormData {
  const existing = formData[connId] ?? {
    tools: null,
    resources: null,
    prompts: null,
  };
  return {
    ...formData,
    [connId]: { ...existing, [field]: value },
  };
}

// Dialog state reducer
interface DialogState {
  activeTab: TabId;
}

type DialogAction = {
  type: "SET_ACTIVE_TAB";
  payload: TabId;
};

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "SET_ACTIVE_TAB":
      return { ...state, activeTab: action.payload };
    default:
      return state;
  }
}

export function DependencySelectionDialog({
  open,
  onOpenChange,
  selectedId,
  form,
  connections,
  onAuthenticate,
}: DependencySelectionDialogProps) {
  const [dialogState, dispatch] = useReducer(dialogReducer, {
    activeTab: "tools",
  });

  const currentConnection = useConnection(selectedId ?? "");

  // Convert connections array to Record for local use
  const formData = connectionsToRecord(connections ?? []);

  const toggleItem = (
    connId: string,
    field: "tools" | "resources" | "prompts",
    itemId: string,
    allItemIds: string[],
  ) => {
    const currentSelection = formData[connId]?.[field];
    let newSelection: SelectionValue;

    if (currentSelection === null) {
      newSelection = allItemIds.filter((id) => id !== itemId);
    } else if (currentSelection?.includes(itemId)) {
      newSelection = currentSelection.filter((id) => id !== itemId);
    } else {
      newSelection = [...(currentSelection ?? []), itemId];
      if (newSelection.length === allItemIds.length) {
        newSelection = null;
      }
    }

    form.setValue(
      "connections",
      recordToConnections(
        withFieldValue(formData, connId, field, newSelection),
      ),
      { shouldDirty: true, shouldTouch: true },
    );
  };

  const toggleAll = (
    connId: string,
    field: "tools" | "resources" | "prompts",
  ) => {
    const current = formData[connId]?.[field];
    const newSelection = current === null ? [] : null;

    form.setValue(
      "connections",
      recordToConnections(
        withFieldValue(formData, connId, field, newSelection),
      ),
      { shouldDirty: true, shouldTouch: true },
    );
  };

  const toggleTool = (
    connId: string,
    toolName: string,
    allToolNames: string[],
  ) => toggleItem(connId, "tools", toolName, allToolNames);
  const toggleResource = (
    connId: string,
    name: string,
    allResourceNames: string[],
  ) => toggleItem(connId, "resources", name, allResourceNames);
  const togglePrompt = (
    connId: string,
    promptName: string,
    allPromptNames: string[],
  ) => toggleItem(connId, "prompts", promptName, allPromptNames);

  const toggleAllTools = (connId: string) => toggleAll(connId, "tools");
  const toggleAllResources = (connId: string) => toggleAll(connId, "resources");
  const toggleAllPrompts = (connId: string) => toggleAll(connId, "prompts");

  if (!selectedId || !currentConnection) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl h-[75vh] max-h-[75vh] flex flex-col p-0 gap-0 overflow-hidden w-[95vw]">
        <Suspense fallback={<LoadingSpinner />}>
          <AuthGate connectionId={selectedId} onAuthenticate={onAuthenticate}>
            <ConnectionDetailsContent
              key={selectedId}
              currentConnection={currentConnection}
              activeTab={dialogState.activeTab}
              selectedId={selectedId}
              formData={formData}
              toggleTool={toggleTool}
              toggleResource={toggleResource}
              togglePrompt={togglePrompt}
              toggleAllTools={toggleAllTools}
              toggleAllResources={toggleAllResources}
              toggleAllPrompts={toggleAllPrompts}
              onTabChange={(value) =>
                dispatch({ type: "SET_ACTIVE_TAB", payload: value })
              }
            />
          </AuthGate>
        </Suspense>

        <DialogFooterComponent onClose={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

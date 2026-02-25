import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { ToolAnnotationBadges } from "@/web/components/tools";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "@deco/ui/components/dialog.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  useConnections,
  useMCPClient,
  useMCPPromptsList,
  useMCPResourcesList,
  useMCPToolsList,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  AlertTriangle,
  CubeOutline,
  File02,
  Loading01,
  Tool01,
} from "@untitledui/icons";
import type { ReactNode } from "react";
import { Suspense, useReducer, useState } from "react";
import type { VirtualMCPConnection } from "@decocms/mesh-sdk/types";
import {
  ALL_ITEMS_SELECTED,
  getSelectionSummaryFromRecord,
  hasAnySelectionsFromRecord,
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
function createMethodNotFoundFallback(notSupportedMessage: string) {
  return ({ error }: { error: Error | null }) => {
    // Check for "Method not found" error (code -32601)
    const isMethodNotFound =
      error?.message?.includes("Method not found") ||
      (error as any)?.code === -32601;

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
          <h3 className="text-lg font-medium">Something went wrong</h3>
          <p className="text-sm text-muted-foreground max-w-xs mx-auto">
            {error?.message
              ? error.message.length > 200
                ? `${error.message.slice(0, 200)}...`
                : error.message
              : "An unexpected error occurred"}
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

// Generic Selection Tab Component
function SelectionTab({
  items,
  selections,
  onToggle,
  onToggleAll,
  emptyMessage,
  disabled,
  searchPlaceholder,
}: {
  items: SelectableItem[];
  selections: SelectionValue;
  onToggle: (itemId: string, allItemIds: string[]) => void;
  onToggleAll: () => void;
  emptyMessage: string;
  disabled?: boolean;
  searchPlaceholder?: string;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const allItemIds = items.map((item) => item.id);
  const displayedItems = searchPlaceholder
    ? items.filter(
        (item) =>
          item.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (item.description &&
            item.description.toLowerCase().includes(searchTerm.toLowerCase())),
      )
    : items;

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
    <div className="flex flex-col h-full">
      {/* Search (optional) */}
      {searchPlaceholder && (
        <div className="shrink-0 border-b border-border">
          <CollectionSearch
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder={searchPlaceholder}
          />
        </div>
      )}

      {/* Select All checkbox */}
      <div className="px-4 border-b border-border shrink-0">
        <label
          className={cn(
            "flex items-start gap-3 p-4",
            disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          )}
        >
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium">
              Select All ({items.length})
              {searchPlaceholder &&
                searchTerm &&
                displayedItems.length !== items.length && (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    — showing {displayedItems.length}
                  </span>
                )}
            </span>
          </div>
          <Checkbox
            checked={selections === null}
            onCheckedChange={onToggleAll}
            disabled={disabled}
            className="mt-0.5"
          />
        </label>
      </div>

      {/* Items list */}
      <div className="flex-1 overflow-auto px-4 py-3 space-y-1">
        {displayedItems.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
            No matches for &quot;{searchTerm}&quot;
          </div>
        ) : (
          displayedItems.map((item) => (
            <SelectionItem
              key={item.id}
              item={item}
              isSelected={selections === null || selections?.includes(item.id)}
              onToggle={() => onToggle(item.id, allItemIds)}
              disabled={disabled}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Tools Tab Wrapper
function ToolsTab({
  connectionId,
  selections,
  onToggle,
  onToggleAll,
  disabled,
}: {
  connectionId: string;
  selections: SelectionValue;
  onToggle: (toolName: string, allToolNames: string[]) => void;
  onToggleAll: () => void;
  disabled?: boolean;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({ connectionId, orgId: org.id });
  const { data } = useMCPToolsList({ client });

  const items: SelectableItem[] = data.tools.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description,
    tags: <ToolAnnotationBadges annotations={tool.annotations} />,
  }));

  const EMPTY_MESSAGE = "No tools available";

  return (
    <SelectionTab
      items={items}
      selections={selections}
      onToggle={onToggle}
      onToggleAll={onToggleAll}
      emptyMessage={EMPTY_MESSAGE}
      disabled={disabled}
      searchPlaceholder="Search tools..."
    />
  );
}

// Resources Tab Wrapper
function ResourcesTab({
  connectionId,
  selections,
  onToggle,
  onToggleAll,
  disabled,
}: {
  connectionId: string;
  selections: SelectionValue;
  onToggle: (name: string, allResourceNames: string[]) => void;
  onToggleAll: () => void;
  disabled?: boolean;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({ connectionId, orgId: org.id });
  const { data } = useMCPResourcesList({ client });

  const items: SelectableItem[] = data.resources.map((resource) => ({
    id: resource.name || resource.uri,
    name: resource.name || resource.uri,
    description: resource.description,
  }));

  const EMPTY_MESSAGE = "No resources available";

  return (
    <SelectionTab
      items={items}
      selections={selections}
      onToggle={onToggle}
      onToggleAll={onToggleAll}
      emptyMessage={EMPTY_MESSAGE}
      disabled={disabled}
    />
  );
}

// Prompts Tab Wrapper
function PromptsTab({
  connectionId,
  selections,
  onToggle,
  onToggleAll,
  disabled,
}: {
  connectionId: string;
  selections: SelectionValue;
  onToggle: (name: string, allPromptNames: string[]) => void;
  onToggleAll: () => void;
  disabled?: boolean;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({ connectionId, orgId: org.id });
  const { data } = useMCPPromptsList({ client });

  const items: SelectableItem[] = data.prompts.map((prompt) => ({
    id: prompt.name,
    name: prompt.name,
    description: prompt.description,
  }));

  const EMPTY_MESSAGE = "No prompts available";

  return (
    <SelectionTab
      items={items}
      selections={selections}
      onToggle={onToggle}
      onToggleAll={onToggleAll}
      emptyMessage={EMPTY_MESSAGE}
      disabled={disabled}
    />
  );
}

// Connection Sidebar Item Component
function ConnectionSidebarItem({
  connection,
  isSelected,
  hasSelections,
  summary,
  onClick,
  onToggleAll,
  disabled,
}: {
  connection: { id: string; title: string; icon?: string | null };
  isSelected: boolean;
  hasSelections: boolean;
  summary: string;
  onClick: () => void;
  onToggleAll: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 p-2 h-12 rounded-lg transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        isSelected ? "bg-accent" : "hover:bg-muted/50",
      )}
      onClick={disabled ? undefined : onClick}
    >
      <IntegrationIcon
        icon={connection.icon}
        name={connection.title}
        size="xs"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <p className="text-sm font-medium text-foreground truncate">
          {connection.title}
        </p>
        {hasSelections && summary && (
          <p className="text-xs text-muted-foreground truncate">{summary}</p>
        )}
      </div>
      <Checkbox
        checked={hasSelections}
        onCheckedChange={onToggleAll}
        onClick={(e) => e.stopPropagation()}
        disabled={disabled}
        className="shrink-0"
      />
    </div>
  );
}

// Connections List Component
function ConnectionsList({
  allConnections,
  searchTerm,
  selectedId,
  hasSelections,
  getSelectionSummary,
  onConnectionClick,
  onToggleAll,
  disabled,
}: {
  allConnections: Array<{
    id: string;
    title: string;
    description?: string | null;
    icon?: string | null;
  }>;
  searchTerm: string;
  selectedId: string | null;
  hasSelections: (connId: string) => boolean;
  getSelectionSummary: (connId: string) => string;
  onConnectionClick: (connId: string) => void;
  onToggleAll: (connId: string) => void;
  disabled?: boolean;
}) {
  const filteredConnections = searchTerm
    ? allConnections.filter(
        (conn) =>
          conn.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
          conn.description?.toLowerCase().includes(searchTerm.toLowerCase()),
      )
    : allConnections;

  if (filteredConnections.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4">
        {searchTerm ? "No connections found" : "No connections available"}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {filteredConnections.map((conn) => (
        <ConnectionSidebarItem
          key={conn.id}
          connection={conn}
          isSelected={selectedId === conn.id}
          hasSelections={hasSelections(conn.id)}
          summary={getSelectionSummary(conn.id)}
          onClick={() => onConnectionClick(conn.id)}
          onToggleAll={() => onToggleAll(conn.id)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

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
  activeTab: "tools" | "resources" | "prompts";
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
  onTabChange: (value: "tools" | "resources" | "prompts") => void;
}) {
  return (
    <>
      {/* Header */}
      <div className="p-6 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <IntegrationIcon
            icon={currentConnection.icon}
            name={currentConnection.title}
            size="md"
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold truncate">
              {currentConnection.title}
            </h2>
            {currentConnection.description && (
              <p className="text-sm text-muted-foreground truncate">
                {currentConnection.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Content - Tabs */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <Tabs
          value={activeTab}
          onValueChange={(value) =>
            onTabChange(value as "tools" | "resources" | "prompts")
          }
          variant="underline"
          className="flex-1 flex flex-col overflow-hidden"
        >
          <TabsList variant="underline" className="shrink-0 px-6">
            <TabsTrigger value="tools" variant="underline" className="gap-2">
              <Tool01 size={16} />
              Tools
            </TabsTrigger>
            <TabsTrigger
              value="resources"
              variant="underline"
              className="gap-2"
            >
              <CubeOutline size={16} />
              Resources
            </TabsTrigger>
            <TabsTrigger value="prompts" variant="underline" className="gap-2">
              <File02 size={16} />
              Prompts
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tools" className="flex-1 overflow-hidden mt-0">
            <ErrorBoundary
              fallback={createMethodNotFoundFallback(
                "Tools not supported by this server",
              )}
            >
              <Suspense fallback={<LoadingSpinner />}>
                <ToolsTab
                  connectionId={selectedId}
                  selections={
                    // IMPORTANT: Do NOT use ?? here!
                    // null means "all selected" (must be preserved)
                    // undefined means "connection not configured" (default to [])
                    // [] means "none selected"
                    // Using ?? would convert null to [], losing the "all selected" state
                    formData[selectedId] ? formData[selectedId]!.tools : []
                  }
                  onToggle={(toolName, allToolNames) =>
                    toggleTool(selectedId, toolName, allToolNames)
                  }
                  onToggleAll={() => toggleAllTools(selectedId)}
                />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>

          <TabsContent
            value="resources"
            className="flex-1 overflow-hidden mt-0"
          >
            <ErrorBoundary
              fallback={createMethodNotFoundFallback(
                "Resources not supported by this server",
              )}
            >
              <Suspense fallback={<LoadingSpinner />}>
                <ResourcesTab
                  connectionId={selectedId}
                  selections={
                    // IMPORTANT: Do NOT use ?? here!
                    // null means "all selected" (must be preserved)
                    // undefined means "connection not configured" (default to [])
                    // [] means "none selected"
                    // Using ?? would convert null to [], losing the "all selected" state
                    formData[selectedId] ? formData[selectedId]!.resources : []
                  }
                  onToggle={(name, allResourceNames) =>
                    toggleResource(selectedId, name, allResourceNames)
                  }
                  onToggleAll={() => toggleAllResources(selectedId)}
                />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="prompts" className="flex-1 overflow-hidden mt-0">
            <ErrorBoundary
              fallback={createMethodNotFoundFallback(
                "Prompts not supported by this server",
              )}
            >
              <Suspense fallback={<LoadingSpinner />}>
                <PromptsTab
                  connectionId={selectedId}
                  selections={
                    // IMPORTANT: Do NOT use ?? here!
                    // null means "all selected" (must be preserved)
                    // undefined means "connection not configured" (default to [])
                    // [] means "none selected"
                    // Using ?? would convert null to [], losing the "all selected" state
                    formData[selectedId] ? formData[selectedId]!.prompts : []
                  }
                  onToggle={(name, allPromptNames) =>
                    togglePrompt(selectedId, name, allPromptNames)
                  }
                  onToggleAll={() => toggleAllPrompts(selectedId)}
                />
              </Suspense>
            </ErrorBoundary>
          </TabsContent>
        </Tabs>
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

// Dialog state reducer
interface DialogState {
  searchTerm: string;
  selectedId: string | null;
  activeTab: "tools" | "resources" | "prompts";
}

type DialogAction =
  | { type: "SET_SEARCH_TERM"; payload: string }
  | { type: "SET_SELECTED"; payload: string | null }
  | { type: "SET_ACTIVE_TAB"; payload: "tools" | "resources" | "prompts" }
  | {
      type: "RESET";
      payload: {
        selectedId: string | null;
        firstConnectionId: string | null;
      };
    }
  | {
      type: "SELECT_CONNECTION";
      payload: string;
    };

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "SET_SEARCH_TERM":
      return { ...state, searchTerm: action.payload };
    case "SET_SELECTED":
      return { ...state, selectedId: action.payload };
    case "SET_ACTIVE_TAB":
      return { ...state, activeTab: action.payload };
    case "RESET":
      return {
        searchTerm: "",
        selectedId:
          action.payload.selectedId ?? action.payload.firstConnectionId ?? null,
        activeTab: "tools",
      };
    case "SELECT_CONNECTION":
      return {
        ...state,
        selectedId: action.payload,
        activeTab: "tools",
      };
    default:
      return state;
  }
}

const findOrFirst = <T extends { id: string }>(
  array: T[],
  id: string | null,
): T | undefined => array.find((item) => item.id === id) ?? array[0];

export function DependencySelectionDialog({
  open,
  onOpenChange,
  selectedId,
  form,
  connections,
}: DependencySelectionDialogProps) {
  const allConnections = useConnections({});

  const [dialogState, dispatch] = useReducer(dialogReducer, {
    activeTab: "tools",
    searchTerm: "",
    selectedId: findOrFirst(allConnections, selectedId)?.id ?? null,
  });

  // Convert connections array to Record for local use
  const formData = connectionsToRecord(connections ?? []);

  const currentConnection = findOrFirst(allConnections, dialogState.selectedId);

  // Use shared helper functions from selection-utils
  const hasSelections = (connId: string): boolean =>
    hasAnySelectionsFromRecord(formData, connId);

  const getSelectionSummary = (connId: string): string =>
    getSelectionSummaryFromRecord(formData, connId);

  // Generic toggle function for individual items
  // Handles state transitions:
  // - null → [all except clicked]: Deselecting from "all selected"
  // - undefined → [clicked]: First selection for this connection
  // - [items] including clicked → [items without clicked]: Deselecting item
  // - [items] not including clicked → [items + clicked]: Selecting item
  // Auto-converts to null when all items manually selected for consistency
  const toggleItem = (
    connId: string,
    field: "tools" | "resources" | "prompts",
    itemId: string,
    allItemIds: string[],
  ) => {
    const currentSelection = formData[connId]?.[field];
    let newSelection: SelectionValue;

    if (currentSelection === null) {
      // State: null (all selected) → [all except clicked]
      // User is deselecting one item from "all selected"
      newSelection = allItemIds.filter((id) => id !== itemId);
    } else if (currentSelection?.includes(itemId)) {
      // State: [items] including clicked → [items without clicked]
      // Deselecting an item
      newSelection = currentSelection.filter((id) => id !== itemId);
    } else {
      // State: undefined or [items] not including clicked → [items + clicked] or null
      // Selecting an item (handles both first selection and adding to existing)
      newSelection = [...(currentSelection ?? []), itemId];
      if (newSelection.length === allItemIds.length) {
        // Auto-convert to null when all items are selected for consistency
        newSelection = null;
      }
    }

    // Update the parent form's connections array
    const updatedFormData: FormData = { ...formData };
    if (!updatedFormData[connId]) {
      updatedFormData[connId] = { tools: null, resources: null, prompts: null };
    } else {
      updatedFormData[connId] = { ...updatedFormData[connId] };
    }
    updatedFormData[connId][field] = newSelection;

    form.setValue("connections", recordToConnections(updatedFormData), {
      shouldDirty: true,
      shouldTouch: true,
    });
  };

  // Toggle all items for a specific field (tools/resources/prompts)
  // Handles state transitions:
  // - null (all selected) → []: Deselect all
  // - anything else (none or some selected) → null: Select all
  const toggleAll = (
    connId: string,
    field: "tools" | "resources" | "prompts",
  ) => {
    const current = formData[connId]?.[field];

    const isAllSelected = current === null;

    const newSelection = isAllSelected ? [] : null;

    // Update the parent form's connections array
    const updatedFormData: FormData = { ...formData };
    if (!updatedFormData[connId]) {
      updatedFormData[connId] = { tools: null, resources: null, prompts: null };
    } else {
      updatedFormData[connId] = { ...updatedFormData[connId] };
    }
    updatedFormData[connId][field] = newSelection;

    form.setValue("connections", recordToConnections(updatedFormData), {
      shouldDirty: true,
      shouldTouch: true,
    });
  };

  // Convenience wrappers for specific types
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

  // Toggle entire connection from sidebar checkbox
  // Handles state transitions:
  // - If all selected (all fields are null) → remove all (delete from formData or set all to [])
  // - If not all selected (some or none) → select all (set all fields to null)
  // Logic matches toggleAll: if all selected, deselect; otherwise, select all
  const toggleAllForConnection = (connId: string) => {
    const current = formData[connId];

    // Check if ALL fields are null (all selected)
    const isAllSelected =
      current &&
      current.tools === null &&
      current.resources === null &&
      current.prompts === null;

    const updatedFormData: FormData = { ...formData };

    if (isAllSelected) {
      // State: all selected → remove all (delete from formData)
      // This removes the connection completely, which means no selections
      delete updatedFormData[connId];
    } else {
      // State: not all selected (some selected or none selected) → select all
      // Set all fields to null (all selected)
      updatedFormData[connId] = ALL_ITEMS_SELECTED;
    }

    form.setValue("connections", recordToConnections(updatedFormData), {
      shouldDirty: true,
      shouldTouch: true,
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      // Reset dialog state when opening
      dispatch({
        type: "RESET",
        payload: {
          selectedId,
          firstConnectionId: allConnections[0]?.id ?? null,
        },
      });
    }
    onOpenChange(newOpen);
  };

  const handleConnectionClick = (connId: string) => {
    dispatch({ type: "SELECT_CONNECTION", payload: connId });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-5xl h-[80vh] max-h-[80vh] flex flex-col p-0 gap-0 overflow-hidden w-[95vw]">
        <div className="flex-1 flex overflow-hidden min-h-0 flex-col sm:flex-row">
          {/* Left Sidebar - Connections List */}
          <div className="w-full sm:w-72 sm:border-r border-b sm:border-b-0 border-border flex flex-col bg-background sm:h-full max-h-[40vh] sm:max-h-full">
            {/* Search */}
            <CollectionSearch
              value={dialogState.searchTerm}
              onChange={(value) =>
                dispatch({ type: "SET_SEARCH_TERM", payload: value })
              }
              placeholder="Search connections..."
            />

            {/* Connections List */}
            <div className="flex-1 overflow-auto p-2">
              <ConnectionsList
                allConnections={allConnections}
                searchTerm={dialogState.searchTerm}
                selectedId={dialogState.selectedId}
                hasSelections={hasSelections}
                getSelectionSummary={getSelectionSummary}
                onConnectionClick={handleConnectionClick}
                onToggleAll={toggleAllForConnection}
              />
            </div>
          </div>

          {/* Right Content - Tools/Resources/Prompts */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {currentConnection && dialogState.selectedId ? (
              <ConnectionDetailsContent
                key={dialogState.selectedId}
                currentConnection={currentConnection}
                activeTab={dialogState.activeTab}
                selectedId={dialogState.selectedId}
                formData={formData}
                toggleTool={toggleTool}
                toggleResource={toggleResource}
                togglePrompt={togglePrompt}
                toggleAllTools={toggleAllTools}
                toggleAllResources={toggleAllResources}
                toggleAllPrompts={toggleAllPrompts}
                onTabChange={(value) =>
                  dispatch({
                    type: "SET_ACTIVE_TAB",
                    payload: value,
                  })
                }
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Select a connection to view its tools, resources, and prompts
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 py-4 border-t border-border shrink-0">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

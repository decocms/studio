/**
 * BindingSelector Component
 *
 * A reusable connection selector that filters connections by binding.
 * Shows connection icons and supports inline installation from registry.
 */

import { useConnections, WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import { useBindingConnections } from "@/web/hooks/use-binding";
import { useInstallFromRegistry } from "@/web/hooks/use-install-from-registry";
import { Loading01, Plus } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import type { Binder } from "@decocms/bindings";
import { connectionImplementsBinding } from "@/web/hooks/use-binding";

export interface BindingSelectorProps {
  /** Currently selected connection ID */
  value: string | null;
  /** Callback when selection changes */
  onValueChange: (value: string | null) => void;
  /** Placeholder text when no selection */
  placeholder?: string;
  /**
   * Binding filter - can be:
   * - A well-known binding name string (e.g., "LLMS", "MCP")
   * - A Binder (zod-based binding from plugin)
   */
  binding?: string | Binder;
  /**
   * Binding type for registry installation (e.g., "@scope/app-name")
   * If provided, enables inline installation from registry
   */
  bindingType?: string;
  /** Callback for custom "Add New" action */
  onAddNew?: () => void;
  /** Additional CSS classes */
  className?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Organization ID - when provided with REPORTS_BINDING, ensures Mesh MCP (Mesh database) is included */
  orgId?: string;
}

export function BindingSelector({
  value,
  onValueChange,
  placeholder = "Select a connection...",
  binding,
  bindingType,
  onAddNew,
  className,
  disabled = false,
  orgId,
}: BindingSelectorProps) {
  const [isLocalInstalling, setIsLocalInstalling] = useState(false);
  const { installByBinding, isInstalling: isGlobalInstalling } =
    useInstallFromRegistry();

  const isInstalling = isLocalInstalling || isGlobalInstalling;

  const allConnections = useConnections();

  // Filter connections based on binding type
  // Use the hook for string bindings
  const hookFilteredConnections = useBindingConnections({
    connections: allConnections,
    binding: typeof binding === "string" ? binding : undefined,
  });

  const filteredConnections = (() => {
    if (!binding || !allConnections) return allConnections ?? [];

    // If it's a string binding (well-known name), use the hook result
    if (typeof binding === "string") {
      return hookFilteredConnections;
    }

    // If it's a Binder (array with zod schemas), filter using connectionImplementsBinding
    if (Array.isArray(binding) && binding.length > 0) {
      return allConnections.filter((conn) =>
        connectionImplementsBinding(conn, binding),
      );
    }

    return allConnections;
  })();

  // Parse binding type for registry-based filtering
  const parsedBindingType = (() => {
    if (!bindingType?.startsWith("@")) return null;
    const [scope, appName] = bindingType.replace("@", "").split("/");
    return scope && appName ? { scope, appName } : null;
  })();

  // For REPORTS_BINDING, include Mesh MCP (Mesh database) if not already in filtered list
  const isReportsBinding =
    Array.isArray(binding) &&
    binding.length > 0 &&
    (binding as { name?: string }[]).some((b) => b.name === "REPORTS_LIST");
  const meshMcp =
    isReportsBinding && orgId
      ? allConnections?.find((c) => c.id === WellKnownOrgMCPId.SELF(orgId))
      : null;
  const meshMcpPrepended =
    meshMcp && !filteredConnections.some((c) => c.id === meshMcp.id)
      ? [meshMcp]
      : [];

  // Further filter by app name if bindingType is provided
  const connections = (() => {
    let result = [...meshMcpPrepended, ...filteredConnections];

    // If we have a Binder, we've already filtered by tools - don't further filter by app name
    const hasBinderFilter = Array.isArray(binding) && binding.length > 0;

    if (parsedBindingType && !hasBinderFilter) {
      result = result.filter((conn) => {
        const connAppName = conn.app_name;
        const connScopeName = (conn.metadata as Record<string, unknown> | null)
          ?.scopeName as string | undefined;

        return (
          connAppName === parsedBindingType.appName &&
          connScopeName === parsedBindingType.scope
        );
      });
    }

    // Include currently selected connection even if it doesn't match filters
    if (value && !result.some((c) => c.id === value)) {
      const selectedConnection = allConnections?.find((c) => c.id === value);
      if (selectedConnection) {
        return [selectedConnection, ...result];
      }
    }

    return result;
  })();

  const canInstallInline = bindingType?.startsWith("@");

  const handleCreateConnection = async () => {
    if (canInstallInline && bindingType) {
      setIsLocalInstalling(true);
      try {
        // installByBinding handles error notifications globally via mutation hooks
        const result = await installByBinding(bindingType);
        if (result) {
          onValueChange(result.id);
        }
      } finally {
        setIsLocalInstalling(false);
      }
      return;
    }

    onAddNew?.();
  };

  // Get selected connection for display
  const selectedConnection = connections.find((c) => c.id === value);

  return (
    <Select
      value={value ?? "none"}
      onValueChange={(v) => onValueChange(v === "none" ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className={cn("w-[200px]", className)}>
        <SelectValue placeholder={placeholder}>
          {selectedConnection ? (
            <div className="flex items-center gap-2">
              {selectedConnection.icon ? (
                <img
                  src={selectedConnection.icon}
                  alt={selectedConnection.title}
                  className="w-4 h-4 rounded shrink-0"
                />
              ) : (
                <div className="w-4 h-4 rounded bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-xs font-semibold text-primary shrink-0">
                  {selectedConnection.title.slice(0, 1).toUpperCase()}
                </div>
              )}
              <span className="truncate">{selectedConnection.title}</span>
            </div>
          ) : (
            placeholder
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No connection</SelectItem>
        {connections.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            No compatible connections found
          </div>
        ) : (
          connections.map((connection) => (
            <SelectItem key={connection.id} value={connection.id}>
              <div className="flex items-center gap-2">
                {connection.icon ? (
                  <img
                    src={connection.icon}
                    alt={connection.title}
                    className="w-4 h-4 rounded"
                  />
                ) : (
                  <div className="w-4 h-4 rounded bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                    {connection.title.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span>{connection.title}</span>
              </div>
            </SelectItem>
          ))
        )}
        {(onAddNew || canInstallInline) && (
          <div className="border-t border-border">
            <Button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleCreateConnection();
              }}
              disabled={isInstalling || disabled}
              variant="ghost"
              className="w-full justify-start gap-2 px-2 py-2 h-auto hover:bg-muted rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              type="button"
            >
              {isInstalling ? (
                <>
                  <Loading01 size={16} className="animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <Plus size={16} />
                  <span>Add Connection</span>
                </>
              )}
            </Button>
          </div>
        )}
      </SelectContent>
    </Select>
  );
}

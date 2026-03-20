// Shared utility functions for handling tool/resource/prompt selections
// across virtual MCP and agent components

import type { VirtualMCPConnection } from "@decocms/mesh-sdk/types";

/**
 * SelectionValue state meanings:
 * - null: all items explicitly selected (e.g., clicked "Select All")
 * - string[]: specific items selected (e.g., ["tool1", "tool2"])
 * - undefined: connection not configured yet (no selections made)
 * Note: Empty array [] means no items selected (all explicitly deselected)
 *
 * CRITICAL: When passing SelectionValue to child components, NEVER use the
 * nullish coalescing operator (??) because it treats both null and undefined
 * as nullish, which would convert null (all selected) to [] (none selected).
 * Always use explicit conditional checks to preserve the null value.
 */
export type SelectionValue = string[] | null;

export interface ConnectionFormValue {
  tools: SelectionValue;
  resources: SelectionValue;
  prompts: SelectionValue;
}

/**
 * Connection selection type - re-exported from SDK for convenience
 * @deprecated Use VirtualMCPConnection from @decocms/mesh-sdk/types instead
 */
export type ConnectionSelection = VirtualMCPConnection;

/**
 * Get the count of selected items
 * @param selection - The selection value (null for all, array for specific items)
 * @returns The count as a number, or "all" string when all items are selected
 */
export function getSelectionCount(selection: SelectionValue): number | "all" {
  if (selection === null) {
    return "all";
  }
  return selection?.length ?? 0;
}

/**
 * Get a summary of selections from a Record structure (used in dialogs)
 * @param formData - Record of connection selections
 * @param connId - Connection ID to get summary for
 * @returns Summary string like "all tools, 3 resources" or empty string if no selections
 */
export function getSelectionSummaryFromRecord(
  formData: Record<string, ConnectionFormValue>,
  connId: string,
): string {
  const sel = formData[connId];
  if (!sel) return "";

  const parts: string[] = [];

  if (sel.tools === null) {
    parts.push("all tools");
  } else if (sel.tools && sel.tools.length > 0) {
    parts.push(`${sel.tools.length} tools`);
  }

  if (sel.resources === null) {
    parts.push("all resources");
  } else if (sel.resources && sel.resources.length > 0) {
    parts.push(`${sel.resources.length} resources`);
  }

  if (sel.prompts === null) {
    parts.push("all prompts");
  } else if (sel.prompts && sel.prompts.length > 0) {
    parts.push(`${sel.prompts.length} prompts`);
  }

  return parts.join(", ");
}

/**
 * Check if a connection has any selections (Record structure version)
 * @param formData - Record of connection selections
 * @param connId - Connection ID to check
 * @returns true if there are any selections, false otherwise
 */
export function hasAnySelectionsFromRecord(
  formData: Record<string, ConnectionFormValue>,
  connId: string,
): boolean {
  const sel = formData[connId];

  // Connection not configured = no selections
  if (!sel) return false;

  // Check if all fields are empty arrays (none selected)
  // null means "all selected", so we exclude it from the "none selected" check
  const noneSelected =
    (sel.tools === undefined ||
      (sel.tools !== null && sel.tools.length === 0)) &&
    (sel.resources === undefined ||
      (sel.resources !== null && sel.resources.length === 0)) &&
    (sel.prompts === undefined ||
      (sel.prompts !== null && sel.prompts.length === 0));

  return !noneSelected;
}

/**
 * Constant representing "all items selected" state (null means all selected)
 */
export const ALL_ITEMS_SELECTED: ConnectionFormValue = {
  tools: null,
  resources: null,
  prompts: null,
} as const;

/**
 * Get a summary of selections from a VirtualMCPConnection object
 * @param connection - The connection object with selections
 * @returns Summary string like "all tools, 3 resources" or "All"
 */
export function getSelectionSummary(connection: VirtualMCPConnection): string {
  const parts: string[] = [];

  if (connection.selected_tools === null) {
    parts.push("all tools");
  } else if (
    connection.selected_tools &&
    connection.selected_tools.length > 0
  ) {
    parts.push(`${connection.selected_tools.length} tools`);
  }

  if (connection.selected_resources === null) {
    parts.push("all resources");
  } else if (
    connection.selected_resources &&
    connection.selected_resources.length > 0
  ) {
    parts.push(`${connection.selected_resources.length} resources`);
  }

  if (connection.selected_prompts === null) {
    parts.push("all prompts");
  } else if (
    connection.selected_prompts &&
    connection.selected_prompts.length > 0
  ) {
    parts.push(`${connection.selected_prompts.length} prompts`);
  }

  return parts.length > 0 ? parts.join(", ") : "All";
}

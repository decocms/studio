// Shared utility functions for handling tool/resource/prompt selections
// across virtual MCP and agent components

import type { VirtualMCPConnection } from "@decocms/shared/sdk/types";

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
 * @deprecated Use VirtualMCPConnection from @decocms/shared/sdk/types instead
 */
export type ConnectionSelection = VirtualMCPConnection;

/**
 * Constant representing "all items selected" state (null means all selected)
 */
export const ALL_ITEMS_SELECTED: ConnectionFormValue = {
  tools: null,
  resources: null,
  prompts: null,
} as const;

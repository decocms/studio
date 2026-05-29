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
 * Constant representing "all items selected" state (null means all selected)
 */
export const ALL_ITEMS_SELECTED: ConnectionFormValue = {
  tools: null,
  resources: null,
  prompts: null,
} as const;

/**
 * Selection fields as stored on a Virtual MCP connection/slot form entry.
 * `null` means "all exposed", `[]` means "none exposed", `[...]` a subset.
 */
export interface ToolSelectionFields {
  selected_tools: SelectionValue;
  selected_resources?: SelectionValue;
  selected_prompts?: SelectionValue;
}

const isEmptyArray = (value: SelectionValue | undefined): boolean =>
  Array.isArray(value) && value.length === 0;

/**
 * A connection/slot is "disabled" only when it exposes nothing at all — i.e.
 * every selection field is an explicit empty array. Anything else (all-null =
 * everything, or a non-empty subset, or an unset field) counts as enabled.
 */
export function isSelectionEnabled(sel: ToolSelectionFields): boolean {
  return !(
    isEmptyArray(sel.selected_tools) &&
    isEmptyArray(sel.selected_resources) &&
    isEmptyArray(sel.selected_prompts)
  );
}

/** Selection fields exposing everything (the enabled state). */
export function enabledSelection(): Required<ToolSelectionFields> {
  return {
    selected_tools: null,
    selected_resources: null,
    selected_prompts: null,
  };
}

/** Selection fields exposing nothing (the disabled state). */
export function disabledSelection(): Required<ToolSelectionFields> {
  return {
    selected_tools: [],
    selected_resources: [],
    selected_prompts: [],
  };
}

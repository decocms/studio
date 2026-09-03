import { createContext, useContext } from "react";

/**
 * True when the surrounding form is read-only — e.g. viewing production, where
 * the CMS stays fully navigable but no value can be edited. Value widgets render
 * inert; mutation controls (add/remove/reorder/delete) disable themselves.
 * Navigation (drill into objects/arrays, expand/collapse, scroll) is untouched.
 */
const ReadOnlyContext = createContext(false);

export const ReadOnlyProvider = ReadOnlyContext.Provider;

export function useIsReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/**
 * The agent whose production a read-only pane is showing — so a blocked field
 * can offer "start a new draft" without threading the id through every field
 * prop. `null` outside a {@link ReadOnlyProvider} that supplied one.
 */
const ReadOnlyVirtualMcpContext = createContext<string | null>(null);

export const ReadOnlyVirtualMcpProvider = ReadOnlyVirtualMcpContext.Provider;

export function useReadOnlyVirtualMcpId(): string | null {
  return useContext(ReadOnlyVirtualMcpContext);
}

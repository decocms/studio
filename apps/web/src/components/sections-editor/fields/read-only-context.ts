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

import { createContext, useContext } from "react";

/**
 * Whether the form edits a Blocks v8 site's content (a content-protocol
 * project, `isProtocolProject`). The sections editor and the content browser
 * provide it; anywhere else, and while that is still being decided, it is
 * `false` and the forms behave as they do on v7.
 */
const V8EditorContext = createContext(false);

export const V8EditorProvider = V8EditorContext.Provider;

export function useV8Editor(): boolean {
  return useContext(V8EditorContext);
}

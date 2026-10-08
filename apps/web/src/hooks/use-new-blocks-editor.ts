import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
} from "react";
import { useOptionalChatTask } from "@/components/chat/context";
import {
  type ContentBackend,
  newBlocksEditorEnabled,
} from "@/components/sections-editor/content-backend";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import { useOrgFlagState } from "@/hooks/use-organization-settings";
import { useProjectContext } from "@/sdk";

/** The site's content backend, for the editors below it; `null`: no site. */
const SiteBackendContext = createContext<ContentBackend["kind"] | null>(null);

/**
 * Tells the editors below it which site they edit (the chat task's project
 * and branch, the same ones the Content and Blocks panels read), so
 * {@link useNewBlocksEditor} can give v8 sites the new editor. Mounted once
 * per surface (the Content and Preview tabs) rather than probed per field.
 */
export function NewBlocksEditorProvider({ children }: { children: ReactNode }) {
  const task = useOptionalChatTask();
  const backend = useContentBackend(task?.virtualMcpId, task?.currentBranch);
  return createElement(
    SiteBackendContext.Provider,
    { value: backend.kind },
    children,
  );
}

/**
 * Whether to show the redesigned blocks editor (see `newBlocksEditorEnabled`):
 * always on v8 sites, the org's `new_blocks_editor` flag on v7 ones and
 * outside a site. `undefined` while that is still being detected — editor
 * roots wait on it rather than flash one editor and swap to the other.
 */
export function useNewBlocksEditorState(): boolean | undefined {
  const backend = useContext(SiteBackendContext);
  const { org } = useProjectContext();
  const flag = useOrgFlagState("new_blocks_editor");
  return newBlocksEditorEnabled({ backend, hasOrg: !!org.id, orgFlag: flag });
}

/** {@link useNewBlocksEditorState}, the old editor until it is known. */
export function useNewBlocksEditor(): boolean {
  return useNewBlocksEditorState() ?? false;
}

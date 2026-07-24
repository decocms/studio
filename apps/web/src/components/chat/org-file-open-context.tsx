/**
 * Supplies the "open an org file referenced in chat" behavior to the markdown
 * renderer. The router/media hooks live here — once per provider — instead of
 * in every inline `<code>`/`<a>` leaf (which `MemoizedMarkdown` renders across
 * chat messages, file previews and PR tabs).
 *
 * Mounted by the agent shell, so it covers the chat and its main panel. On
 * surfaces WITHOUT a provider (e.g. the Library's own file/skill previews on
 * `/$org/files`, which has no main panel and no `?main=` key) the context is
 * null and org-file references render as plain code — clickable only where the
 * navigation actually resolves.
 */

import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { createContext, type ReactNode } from "react";
import { formatLibraryFileTabId } from "@/layouts/main-panel-tabs/tab-id";

export interface OrgFileOpenValue {
  /** Current org slug, for resolving `org/<slug>/…` references. */
  orgSlug: string | undefined;
  /** Current thread id (URL taskId), for resolving `org/output|upload/…`
   *  references into their `<threadId>/` subtree of the shared volume. */
  threadId: string | undefined;
  /** Open a Library browse path ("<volume>/<path…>"). */
  open: (browsePath: string) => void;
}

export const OrgFileOpenContext = createContext<OrgFileOpenValue | null>(null);

/**
 * Next `search` state for opening `browsePath`: mobile gets the dialog overlay
 * (`?preview=`), desktop gets the main-panel side tab (`?main=`). Each branch
 * drops the OTHER model's stale param so a leftover from before a viewport
 * resize can never resolve alongside the freshly-opened file.
 */
export function nextOrgFileOpenSearch(
  prev: Record<string, unknown>,
  browsePath: string,
  isMobile: boolean,
): Record<string, unknown> {
  if (isMobile) {
    const { main: _omit, ...rest } = prev;
    return { ...rest, preview: browsePath };
  }
  const { preview: _omit, ...rest } = prev;
  return { ...rest, main: formatLibraryFileTabId(browsePath) };
}

export function OrgFileOpenProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { org, taskId } = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };

  // Mirror the Library's panel/dialog split: desktop opens the file as a
  // main-panel side tab (`?main=library-file:<path>`); mobile opens the dialog
  // overlay (`?preview=<path>`, rendered by OrgFilePreviewMount).
  const open = (browsePath: string) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) =>
        nextOrgFileOpenSearch(prev, browsePath, isMobile),
    });

  return (
    <OrgFileOpenContext.Provider
      value={{ orgSlug: org, threadId: taskId, open }}
    >
      {children}
    </OrgFileOpenContext.Provider>
  );
}

/**
 * Supplies the "open an org file referenced in chat" behavior to the markdown
 * renderer. The router/media hooks live here — once per provider — instead of
 * in every inline `<code>`/`<a>` leaf (which `MemoizedMarkdown` renders across
 * chat messages, file previews and PR tabs).
 *
 * Mounted by the agent shell, so it covers the chat and its main panel. On
 * surfaces WITHOUT a provider (e.g. the Library's own file/skill previews on
 * `/$org/files`, which has no main panel of its own) the context is null and
 * org-file references render as plain code — clickable only where the
 * navigation actually resolves.
 */

import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { createContext, type ReactNode } from "react";
import { formatLibraryFileTabId } from "@/layouts/main-panel-tabs/tab-id";
import { usePanelNavigate } from "@/layouts/main-panel-tabs/use-panel-navigate";

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

export function OrgFileOpenProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { openPanel } = usePanelNavigate();
  const { org, taskId } = useParams({ strict: false }) as {
    org?: string;
    taskId?: string;
  };

  /**
   * Mirror the Library's panel/dialog split: desktop opens the file as the
   * `library-file` view; mobile opens the dialog overlay (`?preview=<path>`,
   * rendered by OrgFilePreviewMount). Each branch clears the OTHER model — the
   * view or the overlay — so a leftover from before a viewport resize can never
   * resolve alongside the freshly-opened file.
   */
  const open = (browsePath: string) => {
    if (!isMobile) {
      openPanel(formatLibraryFileTabId(browsePath), {
        search: (prev) => ({ ...prev, preview: undefined }),
      });
      return;
    }
    navigate({
      to: ".",
      params: (prev: Record<string, unknown>) => ({
        ...prev,
        panel: undefined,
      }),
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        preview: browsePath,
      }),
    });
  };

  return (
    <OrgFileOpenContext.Provider
      value={{ orgSlug: org, threadId: taskId, open }}
    >
      {children}
    </OrgFileOpenContext.Provider>
  );
}

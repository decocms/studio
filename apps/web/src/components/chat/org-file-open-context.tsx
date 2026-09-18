/**
 * Supplies the "open an org file referenced in chat" behavior to the markdown
 * renderer. The router/media hooks live here — once per provider — instead of
 * in every inline `<code>`/`<a>` leaf (which `MemoizedMarkdown` renders across
 * chat messages, file previews and PR tabs).
 *
 * Mounted by the workspace session shell, so it covers Chat and every
 * route-owned Main surface. Outside that shell the context is null and org-file
 * references render as plain code.
 */

import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { createContext, type ReactNode } from "react";
import { formatLibraryFileTabId } from "@/layouts/main-panel-tabs/tab-id";
import { usePanelNavigate } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useRouteThreadId } from "@/layouts/thread-route";

export interface OrgFileOpenValue {
  /** Current org slug, for resolving `org/<slug>/…` references. */
  orgSlug: string | undefined;
  /** Current thread id (`?thread=` on canonical routes), for resolving `org/output|upload/…`
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
  const params = useParams({ strict: false });
  const org =
    "org" in params && typeof params.org === "string" ? params.org : undefined;
  const threadId = useRouteThreadId() ?? undefined;

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
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        preview: browsePath,
      }),
    });
  };

  return (
    <OrgFileOpenContext.Provider value={{ orgSlug: org, threadId, open }}>
      {children}
    </OrgFileOpenContext.Provider>
  );
}

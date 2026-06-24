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
import { formatLibraryFileTabId } from "@/web/layouts/main-panel-tabs/tab-id";

export interface OrgFileOpenValue {
  /** Current org slug, for resolving `org/<slug>/…` references. */
  orgSlug: string | undefined;
  /** Open a Library browse path ("<volume>/<path…>"). */
  open: (browsePath: string) => void;
}

export const OrgFileOpenContext = createContext<OrgFileOpenValue | null>(null);

export function OrgFileOpenProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { org } = useParams({ strict: false }) as { org?: string };

  // Mirror the Library's panel/dialog split: desktop opens the file as a
  // main-panel side tab (`?main=library-file:<path>`); mobile opens the dialog
  // overlay (`?preview=<path>`, rendered by OrgFilePreviewMount).
  const open = (browsePath: string) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        if (isMobile) return { ...prev, preview: browsePath };
        // Desktop: side tab. Drop any stale `?preview=` so the two models
        // never both resolve to a file at once.
        const { preview: _omit, ...rest } = prev;
        return { ...rest, main: formatLibraryFileTabId(browsePath) };
      },
    });

  return (
    <OrgFileOpenContext.Provider value={{ orgSlug: org, open }}>
      {children}
    </OrgFileOpenContext.Provider>
  );
}

/**
 * Terminal-visibility state shared between the preview's ⋯ menu (which toggles
 * it) and MainPanelWithDrawer (which gates the bottom terminal drawer on it).
 *
 * The terminal is hidden by default — the user opts in via "Show terminal" in
 * the preview overflow menu. The choice is persisted per virtualMcpId so it
 * survives navigation and sandbox restarts (once enabled it also shows during
 * subsequent boots, so clone/install logs are visible again).
 */

import { createContext, use, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = (id: string) => `preview-terminal-visible:${id}`;

function readPersisted(id: string): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(id));
    return raw ? !!JSON.parse(raw).visible : false;
  } catch {
    return false;
  }
}

function writePersisted(id: string, visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY(id), JSON.stringify({ visible }));
  } catch {
    /* ignore */
  }
}

interface TerminalVisibilityCtx {
  visible: boolean;
  setVisible: (visible: boolean) => void;
}

const TerminalVisibilityContext = createContext<TerminalVisibilityCtx | null>(
  null,
);

export function TerminalVisibilityProvider({
  virtualMcpId,
  children,
}: {
  virtualMcpId: string | null;
  children: ReactNode;
}) {
  const storageKey = virtualMcpId ?? "__no-vmcp__";
  const [visible, setVisibleState] = useState<boolean | null>(null);

  // Re-hydrate when the VM changes (render-time setState gated by a ref —
  // idiomatic here; useEffect is banned for derived state).
  const lastKeyRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- hydrate on VM switch
  if (lastKeyRef.current !== storageKey) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- hydrate on VM switch
    lastKeyRef.current = storageKey;
    setVisibleState(readPersisted(storageKey));
  }

  const setVisible = (next: boolean) => {
    setVisibleState(next);
    writePersisted(storageKey, next);
  };

  return (
    <TerminalVisibilityContext
      value={{ visible: visible ?? false, setVisible }}
    >
      {children}
    </TerminalVisibilityContext>
  );
}

/** Returns null when rendered outside a provider (e.g. non-sandbox surfaces). */
export function useTerminalVisibility(): TerminalVisibilityCtx | null {
  return use(TerminalVisibilityContext);
}

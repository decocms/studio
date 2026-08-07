/**
 * Terminal-visibility state shared between the preview's ⋯ menu (which toggles
 * it) and MainPanelWithDrawer (which gates the bottom terminal drawer on it).
 *
 * Default visibility comes from the user's `terminalVisibleByDefault`
 * preference (Settings → Preferences). A per-virtualMcpId Show/Hide choice
 * overrides that default and is persisted so it survives navigation and
 * sandbox restarts (once enabled it also shows during subsequent boots, so
 * clone/install logs are visible again).
 */

import { createContext, use, useRef, useState, type ReactNode } from "react";
import { usePreferences } from "@/hooks/use-preferences.ts";

const STORAGE_KEY = (id: string) => `preview-terminal-visible:${id}`;

/** Per-VM override, or `null` when the user hasn't set one for this VM. */
function readPersisted(id: string): boolean | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed.visible === "boolean" ? parsed.visible : null;
  } catch {
    return null;
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
  const [preferences] = usePreferences();
  // `null` = no per-VM override → fall back to the user's default preference.
  const [override, setOverrideState] = useState<boolean | null>(null);

  // Re-hydrate when the VM changes (render-time setState gated by a ref —
  // idiomatic here; useEffect is banned for derived state).
  const lastKeyRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- hydrate on VM switch
  if (lastKeyRef.current !== storageKey) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- hydrate on VM switch
    lastKeyRef.current = storageKey;
    setOverrideState(readPersisted(storageKey));
  }

  const setVisible = (next: boolean) => {
    setOverrideState(next);
    writePersisted(storageKey, next);
  };

  return (
    <TerminalVisibilityContext
      value={{
        visible: override ?? preferences.terminalVisibleByDefault,
        setVisible,
      }}
    >
      {children}
    </TerminalVisibilityContext>
  );
}

/** Returns null when rendered outside a provider (e.g. non-sandbox surfaces). */
export function useTerminalVisibility(): TerminalVisibilityCtx | null {
  return use(TerminalVisibilityContext);
}

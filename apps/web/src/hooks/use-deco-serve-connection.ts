import { createContext, useContext } from "react";
import {
  type DecoServeConnection,
  parseStoredConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

export interface DecoServeConnectionState {
  /** The project's connected `deco serve`, or `null`. */
  connection: DecoServeConnection | null;
  set: (next: DecoServeConnection) => void;
  clear: () => void;
}

/**
 * `/site-editor`'s connection, which belongs to the tab and to no project.
 * Inside it, every editor surface reads this one instead of a project's.
 */
export const TabDecoServeConnectionContext =
  createContext<DecoServeConnectionState | null>(null);

/**
 * The `deco serve` this browser connected a project to. Per-browser and
 * per-project, like the Local tunnel URL: it points at a server only this
 * machine can reach, so it never belongs on shared project metadata.
 */
export function useDecoServeConnection(
  virtualMcpId: string | null | undefined,
): DecoServeConnectionState {
  const tab = useContext(TabDecoServeConnectionContext);
  const key = LOCALSTORAGE_KEYS.decoServeConnection(virtualMcpId ?? "");
  const [stored, setStored] = useLocalStorage<unknown>(key, null);
  if (tab) return tab;
  return {
    connection: virtualMcpId ? parseStoredConnection(stored) : null,
    set: (next) => setStored(next),
    clear: () => setStored(null),
  };
}

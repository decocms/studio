import {
  type DecoServeConnection,
  parseStoredConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalStorage, writeLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

export interface DecoServeConnectionState {
  /** The project's connected `deco serve`, or `null`. */
  connection: DecoServeConnection | null;
  set: (next: DecoServeConnection) => void;
  clear: () => void;
}

/**
 * The `deco serve` this browser connected a project to. Per-browser and
 * per-project, like the Local tunnel URL: it points at a server only this
 * machine can reach, so it never belongs on shared project metadata.
 */
export function useDecoServeConnection(
  virtualMcpId: string | null | undefined,
): DecoServeConnectionState {
  const key = LOCALSTORAGE_KEYS.decoServeConnection(virtualMcpId ?? "");
  const [stored, setStored] = useLocalStorage<unknown>(key, null);
  return {
    connection: virtualMcpId ? parseStoredConnection(stored) : null,
    set: (next) => setStored(next),
    clear: () => setStored(null),
  };
}

/** Connects a project picked by its id (the connect flow's project list). */
export function useSaveDecoServeConnection() {
  const queryClient = useQueryClient();
  return (virtualMcpId: string, connection: DecoServeConnection) =>
    writeLocalStorage(
      queryClient,
      LOCALSTORAGE_KEYS.decoServeConnection(virtualMcpId),
      connection,
    );
}

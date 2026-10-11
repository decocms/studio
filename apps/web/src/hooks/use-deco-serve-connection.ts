import { createContext, useContext } from "react";
import {
  type DecoServeConnection,
  parseStoredConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { isBlocksV8Project } from "@decocms/shared/thread/session-runtime";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { authClient } from "@/lib/auth-client";
import { useVirtualMCP } from "@/sdk";

export interface DecoServeConnectionState {
  /** The project's connected `deco serve`, or `null`. */
  connection: DecoServeConnection | null;
  set: (next: DecoServeConnection) => void;
  clear: () => void;
}

/**
 * `/site-editor`'s connection, which belongs to no project.
 * Inside it, every editor surface reads this one instead of a project's.
 */
export const TabDecoServeConnectionContext =
  createContext<DecoServeConnectionState | null>(null);

/**
 * The `deco serve` this browser connected a project to (the Localhost choice
 * in the draft selector). Per-browser, per-user and per-project: it points at
 * a server only this machine can reach, so it never belongs on shared project
 * metadata.
 *
 * Only a Blocks v8 site (the server's marker) uses one: on a v7 site a stored
 * connection reads as none, so v7 behaves as on main.
 */
export function useDecoServeConnection(
  virtualMcpId: string | null | undefined,
): DecoServeConnectionState {
  const tab = useContext(TabDecoServeConnectionContext);
  const project = useVirtualMCP(tab ? null : virtualMcpId);
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const key = LOCALSTORAGE_KEYS.decoServeConnection(userId, virtualMcpId ?? "");
  const [stored, setStored] = useLocalStorage<unknown>(key, null);
  if (tab) return tab;
  // Nothing to read or write until the user is known.
  const usable = !!virtualMcpId && !!userId;
  return {
    connection:
      usable && isBlocksV8Project(project?.metadata)
        ? parseStoredConnection(stored)
        : null,
    set: (next) => {
      if (usable) setStored(next);
    },
    clear: () => {
      if (usable) setStored(null);
    },
  };
}

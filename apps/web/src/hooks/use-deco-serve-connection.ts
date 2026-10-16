import { createContext, useContext } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DecoServeConnection,
  parseStoredConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { authClient } from "@/lib/auth-client";
import { type MainSchemaAnswer, useMainSchemaV8 } from "./use-main-schema-v8";

export interface DecoServeConnectionState {
  /** The project's connected `deco serve`, or `null`. */
  connection: DecoServeConnection | null;
  /**
   * A connection is stored but main's schema answer isn't known yet, so it
   * can't be told whether it applies: the editor waits instead of picking
   * another backend first.
   */
  undecided?: boolean;
  /**
   * The endpoint this user last connected the project to, kept after
   * Localhost is turned off: where choosing Localhost again goes. `null`
   * before the first connection (and in `/site-editor`).
   */
  lastEndpoint?: string | null;
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
 * Only a Blocks v8 site (main's schema, `useMainSchemaV8`) uses one: on a v7
 * site a stored connection reads as none, so v7 behaves as on main. Once
 * connected, the `deco serve`'s own schema decides what the editor can do.
 */
export function useDecoServeConnection(
  virtualMcpId: string | null | undefined,
): DecoServeConnectionState {
  const tab = useContext(TabDecoServeConnectionContext);
  const main = useMainSchemaV8(tab ? null : virtualMcpId);
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  // Nothing to read or write until both the user and the project are known:
  // a key is never built with an empty id.
  const usable = !!virtualMcpId && !!userId;
  const [stored, setStored] = useScopedStorage(
    usable ? LOCALSTORAGE_KEYS.decoServeConnection(userId, virtualMcpId) : null,
  );
  const [lastEndpoint, setLastEndpoint] = useScopedStorage(
    usable ? LOCALSTORAGE_KEYS.decoServeEndpoint(userId, virtualMcpId) : null,
  );
  if (tab) return tab;
  const parsed = usable ? parseStoredConnection(stored) : null;
  const { applies, undecided } = storedConnectionApplies(main, !!parsed);
  return {
    connection: applies ? parsed : null,
    undecided,
    lastEndpoint:
      usable && main === "v8" && typeof lastEndpoint === "string"
        ? lastEndpoint
        : null,
    set: (next) => {
      if (!usable) return;
      setStored(next);
      setLastEndpoint(next.endpoint);
    },
    clear: () => {
      if (usable) setStored(null);
    },
  };
}

/**
 * Whether a stored `deco serve` connection is used, from main's schema
 * answer. A v8 site uses it; a v7 one never does (main's Advanced → Local is
 * its local mode). While main's answer loads it is `undecided`. When main
 * can't be read on a site last found v8 (`error`) the stored connection
 * still applies: it only exists because the site was v8, and the `deco
 * serve`'s own schema decides from there. (Any other unreadable main reads
 * as `v7`.)
 */
export function storedConnectionApplies(
  main: MainSchemaAnswer,
  stored: boolean,
): { applies: boolean; undecided: boolean } {
  if (!stored) return { applies: false, undecided: false };
  if (main === "loading") return { applies: false, undecided: true };
  return { applies: main === "v8" || main === "error", undecided: false };
}

function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * A localStorage value under `key`, or `null` with no key. Unlike
 * `useLocalStorage` it never writes on read (no default is stored), and with
 * no key it neither reads nor writes. It shares `useLocalStorage`'s query
 * key, so every reader of the same key sees a write at once.
 */
function useScopedStorage(
  key: string | null,
): [unknown, (value: unknown) => void] {
  const queryClient = useQueryClient();
  const queryKey = ["localStorage", key ?? ""] as const;
  const { data } = useQuery({
    queryKey,
    queryFn: () => (key ? readStored(key) : null),
    initialData: () => (key ? readStored(key) : null),
    enabled: !!key,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  const set = (value: unknown) => {
    if (!key) return;
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the choice lasts for this session only.
    }
    queryClient.setQueryData(queryKey, value);
  };
  return [key ? (data ?? null) : null, set];
}

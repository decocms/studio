import { useState, useSyncExternalStore } from "react";
import { createContentClient } from "@decocms/blocks/protocol";
import { isLoopbackEndpoint } from "@/components/sections-editor/deco-serve-connection";
import {
  type DiscoveryState,
  startDiscovery,
} from "@/components/sections-editor/deco-serve-discovery";
import { probe } from "@/components/sections-editor/use-content-backend";

/** Probes one endpoint, aborting with `signal`; throws when it can't be used. */
export function probeServeEndpoint(
  endpoint: string,
  signal: AbortSignal,
): Promise<unknown> {
  return probe(
    createContentClient({
      endpoint,
      fetch: (request) => fetch(request, { signal }),
    }),
  );
}

/**
 * Chrome's permission for a public page to reach this machine (Local Network
 * Access). `unsupported`: the browser doesn't ask, or Studio itself runs on
 * this machine, which needs no permission. `null` while it is read.
 */
export type LocalNetworkAccess =
  | "granted"
  | "prompt"
  | "denied"
  | "unsupported"
  | null;

/** Chrome has named the permission both ways while it shipped. */
const LNA_PERMISSION_NAMES = ["loopback-network", "local-network-access"];

async function queryLocalNetworkAccess(): Promise<PermissionStatus | null> {
  if (isLoopbackEndpoint(window.location.origin)) return null;
  for (const name of LNA_PERMISSION_NAMES) {
    try {
      return await navigator.permissions.query({
        name: name as PermissionName,
      });
    } catch {
      // Not a permission this browser knows.
    }
  }
  return null;
}

let lnaState: LocalNetworkAccess = null;
let lnaStarted = false;
const lnaListeners = new Set<() => void>();

function subscribeLocalNetworkAccess(onChange: () => void): () => void {
  lnaListeners.add(onChange);
  if (!lnaStarted) {
    lnaStarted = true;
    const notify = (next: LocalNetworkAccess) => {
      lnaState = next;
      for (const listener of lnaListeners) listener();
    };
    void queryLocalNetworkAccess().then((status) => {
      if (!status) return notify("unsupported");
      notify(status.state as LocalNetworkAccess);
      status.addEventListener("change", () =>
        notify(status.state as LocalNetworkAccess),
      );
    });
  }
  return () => lnaListeners.delete(onChange);
}

const IDLE: DiscoveryState = {
  status: "stopped",
  firstRoundDone: false,
  problem: null,
};

interface DiscoveryStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => DiscoveryState;
  /** Set on every render by the hook, so the latest callback is called. */
  onFound: (endpoint: string) => void;
}

/** One running search per candidate list, while something subscribes to it. */
const stores = new Map<string, DiscoveryStore>();

function discoveryStore(key: string): DiscoveryStore {
  const existing = stores.get(key);
  if (existing) return existing;
  let state: DiscoveryState = {
    status: "searching",
    firstRoundDone: false,
    problem: null,
  };
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const store: DiscoveryStore = {
    onFound: () => {},
    getSnapshot: () => state,
    subscribe: (onChange) => {
      listeners.add(onChange);
      stop ??= startDiscovery({
        candidates: key.split(" "),
        probe: probeServeEndpoint,
        onFound: (endpoint) => store.onFound(endpoint),
        onChange: (next) => {
          state = next;
          for (const listener of listeners) listener();
        },
      });
      return () => {
        listeners.delete(onChange);
        if (listeners.size > 0) return;
        stop?.();
        stop = null;
        stores.delete(key);
      };
    },
  };
  stores.set(key, store);
  return store;
}

const noSubscribe = () => () => {};
const idleSnapshot = () => IDLE;
const lnaSnapshot = () => lnaState;

/**
 * Looks for a running `deco serve` while `enabled` (see `startDiscovery`).
 * Where Chrome would ask for permission first, it waits for `start()` (a
 * click on a button that says what Chrome is about to ask), so the prompt
 * never appears before the page explains it.
 */
export function useDecoServeDiscovery({
  candidates,
  enabled,
  onFound,
}: {
  candidates: readonly string[];
  enabled: boolean;
  onFound: (endpoint: string) => void;
}) {
  const [asked, setAsked] = useState(false);
  const access = useSyncExternalStore(
    subscribeLocalNetworkAccess,
    lnaSnapshot,
    lnaSnapshot,
  );
  const canProbe =
    access === "granted" ||
    access === "unsupported" ||
    (access === "prompt" && asked);
  const active = enabled && canProbe && candidates.length > 0;
  const store = active ? discoveryStore(candidates.join(" ")) : null;
  if (store) store.onFound = onFound;
  const state = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getSnapshot ?? idleSnapshot,
    store?.getSnapshot ?? idleSnapshot,
  );

  return {
    state,
    access,
    /** Whether the search waits for `start()`. */
    needsGesture: access === "prompt" && !asked,
    start: () => setAsked(true),
  };
}

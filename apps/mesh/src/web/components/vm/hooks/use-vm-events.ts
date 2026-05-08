/** Thin hooks over VmEventsContext. EventSource lifecycle lives in the provider. */

import { use, useEffect, useRef } from "react";
import {
  VmEventsContext,
  type ChunkHandler,
  type ReloadHandler,
} from "./vm-events-context.tsx";

export type {
  BranchStatus,
  BranchStatusReady,
  ChunkHandler,
  ReloadHandler,
  VmStatus,
} from "./vm-events-context.tsx";

export function useVmEvents() {
  return use(VmEventsContext);
}

export function useVmChunkHandler(handler: ChunkHandler | null) {
  const { subscribeChunks } = useVmEvents();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — subscription lifecycle bound to the component mount; uses ref for stable identity
  useEffect(() => {
    const fn: ChunkHandler = (source, data) => {
      handlerRef.current?.(source, data);
    };
    const unsubscribe = subscribeChunks(fn);
    return unsubscribe;
  }, [subscribeChunks]);
}

/** Daemon "reload" = config edits framework HMR won't catch (.ts/.tsx uses framework HMR). */
export function useVmReloadHandler(handler: ReloadHandler | null) {
  const { subscribeReload } = useVmEvents();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — subscription lifecycle bound to the component mount; uses ref for stable identity
  useEffect(() => {
    const fn: ReloadHandler = () => {
      handlerRef.current?.();
    };
    const unsubscribe = subscribeReload(fn);
    return unsubscribe;
  }, [subscribeReload]);
}

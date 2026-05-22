/** Thin hooks over SandboxEventsContext. EventSource lifecycle lives in the provider. */

import { use, useEffect, useRef } from "react";
import {
  SandboxEventsContext,
  type ChunkHandler,
  type ReloadHandler,
} from "./sandbox-events-context.tsx";

export type {
  BranchMeta,
  ChunkHandler,
  DaemonStatus,
  LifecycleState,
  ReloadHandler,
} from "./sandbox-events-context.tsx";

export function useSandboxEvents() {
  return use(SandboxEventsContext);
}

export function useSandboxChunkHandler(handler: ChunkHandler | null) {
  const { subscribeChunks } = useSandboxEvents();
  const handlerRef = useRef(handler);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
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
export function useSandboxReloadHandler(handler: ReloadHandler | null) {
  const { subscribeReload } = useSandboxEvents();
  const handlerRef = useRef(handler);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
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

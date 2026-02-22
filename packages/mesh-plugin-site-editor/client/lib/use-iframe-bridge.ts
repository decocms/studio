import { useRef, useCallback, useSyncExternalStore } from "react";
import type { Page } from "./page-api";

export type IframeMode = "edit" | "interact";

export interface IframeMessage {
  type: string;
  payload?: unknown;
}

export interface UseIframeBridgeOptions {
  page: Page | null;
  selectedBlockId: string | null;
  mode: IframeMode;
  onBlockClicked?: (id: string) => void;
  onClickAway?: () => void;
}

export interface UseIframeBridgeResult {
  setIframeRef: (el: HTMLIFrameElement | null) => void;
  send: (msg: IframeMessage) => void;
  ready: boolean;
  disconnected: boolean;
  reconnect: () => void;
  hoverRect: DOMRect | null;
  clearHover: () => void;
}

// External store for iframe messages — bridges window events to React
interface IframeStore {
  subscribe: (notify: () => void) => () => void;
  getSnapshot: () => MessageEvent | null;
}

function createIframeStore(): IframeStore {
  let lastMessage: MessageEvent | null = null;
  const listeners = new Set<() => void>();

  const handler = (event: MessageEvent) => {
    lastMessage = event;
    for (const notify of listeners) notify();
  };

  return {
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      if (listeners.size === 1) {
        window.addEventListener("message", handler);
      }
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          window.removeEventListener("message", handler);
        }
      };
    },
    getSnapshot: () => lastMessage,
  };
}

// Module-level store (singleton) — avoids recreating on each render
const iframeStore = createIframeStore();

export function useIframeBridge(
  options: UseIframeBridgeOptions,
): UseIframeBridgeResult {
  const { page, mode, onBlockClicked, onClickAway } = options;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const disconnectedRef = useRef(false);
  const hoverRectRef = useRef<DOMRect | null>(null);

  // Subscribe to window messages via useSyncExternalStore (not useEffect — banned)
  const lastMessage = useSyncExternalStore(
    iframeStore.subscribe,
    iframeStore.getSnapshot,
    () => null, // server snapshot
  );

  // Process incoming iframe message
  // This runs during render — intentionally side-effect-free except for ref updates
  // (Ref updates don't cause re-renders, so this is safe)
  if (lastMessage && iframeRef.current) {
    const msg = lastMessage.data as IframeMessage | undefined;
    if (msg?.type === "HANDSHAKE_COMPLETE") {
      readyRef.current = true;
      disconnectedRef.current = false;
    } else if (msg?.type === "DISCONNECT") {
      disconnectedRef.current = true;
    } else if (msg?.type === "BLOCK_CLICKED") {
      const id = msg.payload as string;
      if (id) onBlockClicked?.(id);
      else onClickAway?.();
    } else if (msg?.type === "HOVER_RECT") {
      hoverRectRef.current = msg.payload as DOMRect | null;
    }
  }

  const send = useCallback((msg: IframeMessage) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const setIframeRef = useCallback((el: HTMLIFrameElement | null) => {
    iframeRef.current = el;
    if (el) {
      // Send initial handshake when iframe is mounted
      el.onload = () => {
        el.contentWindow?.postMessage({ type: "HANDSHAKE" }, "*");
      };
    }
  }, []);

  const reconnect = useCallback(() => {
    disconnectedRef.current = false;
    iframeRef.current?.contentWindow?.postMessage({ type: "HANDSHAKE" }, "*");
  }, []);

  const clearHover = useCallback(() => {
    hoverRectRef.current = null;
  }, []);

  // Sync page/mode changes to iframe
  // Ref-based change detection — no useEffect needed
  const prevPageRef = useRef<Page | null>(null);
  const prevModeRef = useRef<IframeMode>("edit");

  if (readyRef.current) {
    if (prevPageRef.current !== page) {
      prevPageRef.current = page;
      send({ type: "PAGE_UPDATE", payload: page });
    }
    if (prevModeRef.current !== mode) {
      prevModeRef.current = mode;
      send({ type: "MODE_CHANGE", payload: mode });
    }
  }

  return {
    setIframeRef,
    send,
    ready: readyRef.current,
    disconnected: disconnectedRef.current,
    reconnect,
    hoverRect: hoverRectRef.current,
    clearHover,
  };
}

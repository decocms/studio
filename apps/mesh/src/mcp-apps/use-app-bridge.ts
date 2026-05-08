import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiMessageRequest,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps";
import { getDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
// eslint-disable-next-line ban-use-effect/ban-use-effect
import { useEffect, useRef, useSyncExternalStore } from "react";
import { readHostStyles } from "./host-styles";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOST_INFO = { name: "MCP Mesh", version: "1.0.0" } as const;

const HOST_CAPABILITIES: McpUiHostCapabilities = {
  openLinks: {},
  serverTools: {},
  serverResources: {},
  logging: {},
  message: {},
  downloadFile: {},
  updateModelContext: { text: {} },
};

const INIT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectLocale(): string {
  if (typeof navigator === "undefined") return "en";
  return navigator.language ?? "en";
}

function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function detectPlatform(): "web" | "desktop" | "mobile" {
  if (typeof navigator === "undefined") return "web";
  return /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "web";
}

function buildHostContext(
  displayMode: McpUiDisplayMode,
  toolInfo?: McpUiHostContext["toolInfo"],
  maxHeight?: number,
  orgId?: string,
): McpUiHostContext {
  return {
    theme: getDocumentTheme(),
    styles: readHostStyles(),
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    locale: detectLocale(),
    timeZone: detectTimeZone(),
    platform: detectPlatform(),
    ...(toolInfo != null && { toolInfo }),
    ...(maxHeight != null && {
      containerDimensions: { maxHeight },
    }),
    ...(orgId != null && { orgId }),
  };
}

// ---------------------------------------------------------------------------
// Shared theme observer (singleton) — watches <html> class/data-theme changes
// and system preference, notifies all BridgeStore instances.
// ---------------------------------------------------------------------------

type ThemeListener = () => void;
const themeListeners = new Set<ThemeListener>();
let observerStarted = false;

function startThemeObserver() {
  if (observerStarted || typeof document === "undefined") return;
  observerStarted = true;

  const notify = () => themeListeners.forEach((fn) => fn());

  new MutationObserver(notify).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", notify);
}

function subscribeThemeChange(fn: ThemeListener): () => void {
  themeListeners.add(fn);
  startThemeObserver();
  return () => themeListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// BridgeStore — a self-contained external store that owns the full AppBridge
// lifecycle: creation, handler wiring, iframe attachment, teardown, and the
// observable snapshot that React subscribes to via useSyncExternalStore.
//
// React never touches AppBridge directly. The component calls store.attach()
// from an iframe ref callback and reads state through getSnapshot().
// ---------------------------------------------------------------------------

interface BridgeSnapshot {
  height: number;
  isLoading: boolean;
  error: string | null;
}

interface BridgeStoreConfig {
  client: Client;
  displayMode: McpUiDisplayMode;
  minHeight: number;
  maxHeight: number;
  orgId?: string;
  toolInfo?: McpUiHostContext["toolInfo"];
  toolInput?: Record<string, unknown>;
  toolResult?: CallToolResult;
  onMessage?: (params: McpUiMessageRequest["params"]) => void;
  onUpdateModelContext?: (
    params: McpUiUpdateModelContextRequest["params"],
  ) => void;
  onTeardown?: () => void;
  onRequestDisplayMode?: (
    mode: McpUiDisplayMode,
  ) => McpUiDisplayMode | Promise<McpUiDisplayMode>;
}

class BridgeStore {
  // --- imperative state (invisible to React) ---
  private bridge: AppBridge | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private unsubTheme: (() => void) | null = null;

  // --- observable snapshot (React subscribes to this) ---
  private snapshot: BridgeSnapshot;
  private listeners = new Set<() => void>();

  // --- mutable config (updated every render via updateConfig) ---
  private config: BridgeStoreConfig;

  constructor(config: BridgeStoreConfig) {
    this.config = config;
    this.snapshot = Object.freeze({
      height: config.minHeight,
      isLoading: true,
      error: null,
    });
  }

  // ---- useSyncExternalStore contract ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BridgeSnapshot => {
    return this.snapshot;
  };

  // ---- config updates (called every render) ----

  /**
   * Update the config and, if the bridge is already initialized, push any
   * changed toolInput/toolResult to the view automatically.
   */
  updateConfig(config: BridgeStoreConfig) {
    const prev = this.config;
    this.config = config;

    if (!this.bridge || this.disposed) return;

    if (config.displayMode !== prev.displayMode) {
      this.pushHostContext();
    }
    if (config.toolInput !== prev.toolInput && config.toolInput != null) {
      this.bridge.sendToolInput({ arguments: config.toolInput });
    }
    if (config.toolResult !== prev.toolResult && config.toolResult != null) {
      this.bridge.sendToolResult(config.toolResult);
    }
  }

  /** Rebuild and push full host context to the bridge (e.g. on theme change). */
  private pushHostContext() {
    if (!this.bridge || this.disposed) return;
    const { displayMode, maxHeight, toolInfo, orgId } = this.config;
    this.bridge.setHostContext(
      buildHostContext(displayMode, toolInfo, maxHeight, orgId),
    );
  }

  // ---- snapshot mutations ----

  private set(partial: Partial<BridgeSnapshot>) {
    const prev = this.snapshot;
    const next = { ...prev, ...partial };

    if (
      next.height === prev.height &&
      next.isLoading === prev.isLoading &&
      next.error === prev.error
    ) {
      return;
    }

    this.snapshot = Object.freeze(next);
    for (const listener of this.listeners) {
      listener();
    }
  }

  // ---- bridge lifecycle ----

  /** Tear down the current bridge and clear timers. */
  teardown() {
    if (this.bridge || this.timeout || this.unsubTheme) {
      this.config.onTeardown?.();
    }
    this.disposed = true;
    this.unsubTheme?.();
    this.unsubTheme = null;
    if (this.bridge) {
      this.bridge.teardownResource({}).catch(() => {});
      this.bridge.close();
      this.bridge = null;
    }
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  /** Attach to an iframe: create a bridge, wire handlers, connect transport.
   *  Called from the iframe ref callback — this is the only entry point for
   *  bridge creation. Pass `null` to detach / teardown. */
  attach = (iframe: HTMLIFrameElement | null) => {
    this.teardown();
    this.disposed = false;
    this.set({
      height: this.config.minHeight,
      isLoading: true,
      error: null,
    });

    if (!iframe) return;

    iframe.onerror = () => {
      if (this.disposed) return;
      this.set({ error: "Failed to load app", isLoading: false });
    };

    try {
      const { client, displayMode, maxHeight, toolInfo, orgId } = this.config;
      const hostContext = buildHostContext(
        displayMode,
        toolInfo,
        maxHeight,
        orgId,
      );

      // Pass the MCP client directly — AppBridge auto-wires oncalltool,
      // onreadresource, onlistresources, etc. via the client's capabilities.
      const bridge = new AppBridge(client, HOST_INFO, HOST_CAPABILITIES, {
        hostContext,
      });
      this.bridge = bridge;

      this.registerHandlers(bridge);
      this.startInitTimeout();
      this.registerInitHandler(bridge);
      this.connectTransport(bridge, iframe);

      this.unsubTheme = subscribeThemeChange(() => this.pushHostContext());
    } catch (err) {
      this.clearTimeout();
      console.error("Failed to create AppBridge:", err);
      this.set({
        error: err instanceof Error ? err.message : "Unknown error",
        isLoading: false,
      });
    }
  };

  // ---- private handler registration ----

  private registerHandlers(bridge: AppBridge) {
    bridge.onopenlink = async ({ url }) => {
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        // invalid URL
      }
      if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Only http and https URLs are allowed");
      }
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };

    bridge.onmessage = async (params) => {
      this.config.onMessage?.(params);
      return {};
    };

    bridge.onupdatemodelcontext = async (params) => {
      this.config.onUpdateModelContext?.(params);
      return {};
    };

    bridge.onsizechange = ({ height: h }) => {
      if (this.disposed) return;
      if (h != null) {
        const { minHeight, maxHeight } = this.config;
        this.set({ height: Math.max(minHeight, Math.min(maxHeight, h)) });
      }
    };

    bridge.onloggingmessage = ({ level, data }) => {
      const method = level === "error" ? "error" : "debug";
      console[method](
        `[MCP App ${this.config.toolInfo?.tool.name ?? "unknown"}]`,
        data,
      );
    };

    bridge.onrequestdisplaymode = async ({ mode }) => {
      const actualMode = this.config.onRequestDisplayMode
        ? await this.config.onRequestDisplayMode(mode)
        : this.config.displayMode;
      return { mode: actualMode };
    };

    bridge.ondownloadfile = async ({ contents }) => {
      for (const item of contents) {
        if (item.type === "resource") {
          const res = item.resource;
          const blob =
            "blob" in res
              ? new Blob(
                  [Uint8Array.from(atob(res.blob), (c) => c.charCodeAt(0))],
                  { type: res.mimeType },
                )
              : new Blob([res.text ?? ""], { type: res.mimeType });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = res.uri.split("/").pop() ?? "download";
          link.click();
          URL.revokeObjectURL(url);
        } else if (item.type === "resource_link") {
          window.open(item.uri, "_blank");
        }
      }
      return {};
    };
  }

  private registerInitHandler(bridge: AppBridge) {
    bridge.oninitialized = () => {
      if (this.disposed) return;
      this.clearTimeout();
      this.set({ isLoading: false });

      const { toolInput, toolResult } = this.config;
      if (toolInput != null) {
        bridge.sendToolInput({ arguments: toolInput });
      }
      if (toolResult != null) {
        bridge.sendToolResult(toolResult);
      }
    };
  }

  private startInitTimeout() {
    this.timeout = setTimeout(() => {
      if (this.disposed) return;
      this.set({ error: "App took too long to load", isLoading: false });
    }, INIT_TIMEOUT_MS);
  }

  private clearTimeout() {
    if (this.timeout) {
      globalThis.clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private connectTransport(bridge: AppBridge, iframe: HTMLIFrameElement) {
    if (!iframe.contentWindow) {
      console.warn("iframe contentWindow not yet available");
      return;
    }

    const transport = new PostMessageTransport(
      iframe.contentWindow,
      iframe.contentWindow,
    );
    bridge.connect(transport).catch((err: unknown) => {
      if (this.disposed) return;
      this.clearTimeout();
      console.error("AppBridge connect failed:", err);
      this.set({
        error: err instanceof Error ? err.message : "Connection failed",
        isLoading: false,
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Hook — thin React binding over BridgeStore
// ---------------------------------------------------------------------------

interface UseAppBridgeOptions {
  client: Client;
  displayMode: McpUiDisplayMode;
  minHeight: number;
  maxHeight: number;
  orgId?: string;
  toolInfo?: McpUiHostContext["toolInfo"];
  toolInput?: Record<string, unknown>;
  toolResult?: CallToolResult;
  onMessage?: (params: McpUiMessageRequest["params"]) => void;
  onUpdateModelContext?: (
    params: McpUiUpdateModelContextRequest["params"],
  ) => void;
  onTeardown?: () => void;
  onRequestDisplayMode?: (
    mode: McpUiDisplayMode,
  ) => McpUiDisplayMode | Promise<McpUiDisplayMode>;
}

interface UseAppBridgeReturn {
  height: number;
  isLoading: boolean;
  error: string | null;
  iframeRef: (iframe: HTMLIFrameElement | null) => void;
}

export function useAppBridge(options: UseAppBridgeOptions): UseAppBridgeReturn {
  const storeRef = useRef<BridgeStore>(new BridgeStore(options));

  // Sync props into the store so bridge handlers always read current values
  // and push toolInput/toolResult changes to the view through the bridge.
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    storeRef.current.updateConfig(options);
  }, [options]);

  const { height, isLoading, error } = useSyncExternalStore(
    storeRef.current.subscribe,
    storeRef.current.getSnapshot,
  );

  return {
    height,
    isLoading,
    error,
    iframeRef: storeRef.current.attach,
  };
}

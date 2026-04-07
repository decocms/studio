/**
 * Virtual MCP Context — Types, context object, and hooks for URL-driven virtual MCP state.
 *
 * The actual provider logic lives in VirtualMCPProvider.
 * This file exports the context, hooks, and types consumed by components.
 *
 * Navigation actions (openMainView, openTask) have moved to useLayoutState
 * and useChatNavigation respectively.
 */

import { createContext, use } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MainViewType = "chat" | "settings" | "automation" | "ext-apps";

export type MainView =
  | { type: "chat" }
  | { type: "settings" }
  | { type: "automation"; id: string }
  | {
      type: "ext-apps";
      id: string;
      toolName?: string;
      [key: string]: unknown;
    }
  | null; // null = no explicit `main` param — consumer resolves default

export interface VirtualMCPContextValue {
  virtualMcpId: string;
  mainView: MainView;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const VirtualMCPContext = createContext<VirtualMCPContextValue | null>(
  null,
);

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useVirtualMCPContext(): VirtualMCPContextValue {
  const ctx = use(VirtualMCPContext);
  if (!ctx) {
    throw new Error(
      "useVirtualMCPContext must be used within a VirtualMCPProvider",
    );
  }
  return ctx;
}

/** Returns null when not inside a virtual MCP route — safe for components used in both contexts. */
export function useVirtualMCPURLContext(): VirtualMCPContextValue | null {
  return use(VirtualMCPContext);
}

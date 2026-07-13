/**
 * Agent scope — the currently-selected agent that scopes the sidebar thread
 * list, set from the toolbar breadcrumb's agent picker.
 *
 * `null` means "all agents" (the Decopilot / everything view). When you're
 * inside a thread the sidebar snaps its filter to that thread's agent instead;
 * this scope is the home-browsing selection you return to.
 *
 * Lives at the org-shell level so the breadcrumb (toolbar) and the thread list
 * (sidebar) share one source of truth without threading it through the URL.
 */
import { createContext, useContext, useState, type ReactNode } from "react";

interface AgentScopeValue {
  /** Selected agent id, or null for "all agents". */
  scopeAgentId: string | null;
  setScopeAgentId: (id: string | null) => void;
}

const AgentScopeContext = createContext<AgentScopeValue | null>(null);

export function AgentScopeProvider({ children }: { children: ReactNode }) {
  const [scopeAgentId, setScopeAgentId] = useState<string | null>(null);
  return (
    <AgentScopeContext value={{ scopeAgentId, setScopeAgentId }}>
      {children}
    </AgentScopeContext>
  );
}

export function useAgentScope(): AgentScopeValue {
  const ctx = useContext(AgentScopeContext);
  if (!ctx) {
    // Tolerate consumers mounted outside the provider (e.g. transient states) —
    // behave as "all agents", no-op setter.
    return { scopeAgentId: null, setScopeAgentId: () => {} };
  }
  return ctx;
}

import {
  createContext,
  useContext,
  type ComponentType,
  type PropsWithChildren,
} from "react";

export interface AgentRuntimeActiveTaskProps extends PropsWithChildren {
  taskId: string;
}

/**
 * Transport-free seam between the shared Studio shell and the runtime used by
 * a particular entry point. The hosted entry deliberately installs nothing;
 * the native entry installs the terminal runtime.
 */
export interface AgentRuntimeAdapter {
  ActiveTaskProvider: ComponentType<AgentRuntimeActiveTaskProps>;
  SidePanel: ComponentType;
}

const AgentRuntimeSlotContext = createContext<AgentRuntimeAdapter | null>(null);

export function AgentRuntimeSlotProvider({
  adapter,
  children,
}: PropsWithChildren<{ adapter: AgentRuntimeAdapter }>) {
  return (
    <AgentRuntimeSlotContext.Provider value={adapter}>
      {children}
    </AgentRuntimeSlotContext.Provider>
  );
}

export function useAgentRuntimeAdapter(): AgentRuntimeAdapter | null {
  return useContext(AgentRuntimeSlotContext);
}

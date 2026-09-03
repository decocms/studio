import { createContext, useContext, useState, type ReactNode } from "react";

interface SidebarAgentGroupsContextValue {
  empty: boolean;
  setEmpty: (next: boolean) => void;
}

const SidebarAgentGroupsContext =
  createContext<SidebarAgentGroupsContextValue | null>(null);

export function SidebarAgentGroupsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [empty, setEmpty] = useState(false);

  return (
    <SidebarAgentGroupsContext.Provider value={{ empty, setEmpty }}>
      {children}
    </SidebarAgentGroupsContext.Provider>
  );
}

export function useSidebarAgentGroupsEmpty(): boolean {
  return useContext(SidebarAgentGroupsContext)?.empty ?? false;
}

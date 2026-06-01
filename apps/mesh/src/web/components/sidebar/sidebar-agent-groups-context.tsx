import { createContext, useContext, useState, type ReactNode } from "react";

interface SidebarAgentGroupsContextValue {
  empty: boolean;
  setEmpty: (next: boolean) => void;
  orderRevision: number;
  bumpOrderRevision: () => void;
}

const SidebarAgentGroupsContext =
  createContext<SidebarAgentGroupsContextValue | null>(null);

export function SidebarAgentGroupsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [empty, setEmpty] = useState(false);
  const [orderRevision, setOrderRevision] = useState(0);
  const bumpOrderRevision = () => setOrderRevision((n) => n + 1);

  return (
    <SidebarAgentGroupsContext.Provider
      value={{ empty, setEmpty, orderRevision, bumpOrderRevision }}
    >
      {children}
    </SidebarAgentGroupsContext.Provider>
  );
}

export function useSidebarAgentGroupsEmpty(): boolean {
  return useContext(SidebarAgentGroupsContext)?.empty ?? false;
}

export function useSidebarOrderRevision(): number {
  return useContext(SidebarAgentGroupsContext)?.orderRevision ?? 0;
}

export function useBumpSidebarOrderRevision(): () => void {
  return useContext(SidebarAgentGroupsContext)?.bumpOrderRevision ?? (() => {});
}

export function SyncSidebarAgentGroupsEmpty({ value }: { value: boolean }) {
  const ctx = useContext(SidebarAgentGroupsContext);
  const [prev, setPrev] = useState<boolean | null>(null);
  if (ctx && prev !== value) {
    ctx.setEmpty(value);
    setPrev(value);
  }
  return null;
}

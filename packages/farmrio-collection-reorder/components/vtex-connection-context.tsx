import type { PluginConnectionEntity } from "@decocms/bindings";
import { createContext, useContext, type ReactNode } from "react";

type VtexToolCaller = (
  toolName: "VTEX_REORDER_COLLECTION",
  args: { collectionId: string; xml: string },
) => Promise<unknown>;

type VtexConnectionContextValue = {
  connection: PluginConnectionEntity | null;
  toolCaller: VtexToolCaller | null;
};

const VtexConnectionContext = createContext<VtexConnectionContextValue | null>(
  null,
);

export function VtexConnectionProvider({
  value,
  children,
}: {
  value: VtexConnectionContextValue;
  children: ReactNode;
}) {
  return (
    <VtexConnectionContext.Provider value={value}>
      {children}
    </VtexConnectionContext.Provider>
  );
}

export function useVtexConnectionContext(): VtexConnectionContextValue {
  const context = useContext(VtexConnectionContext);
  if (!context) {
    throw new Error(
      "useVtexConnectionContext must be used within VtexConnectionProvider",
    );
  }
  return context;
}

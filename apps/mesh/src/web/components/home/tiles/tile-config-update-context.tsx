import { createContext, type ReactNode } from "react";

type UpdateTileConfig = (id: string, patch: Record<string, unknown>) => void;

const TileConfigUpdateContext = createContext<UpdateTileConfig | null>(null);

export function TileConfigUpdateProvider({
  onUpdate,
  children,
}: {
  onUpdate: UpdateTileConfig;
  children: ReactNode;
}) {
  return (
    <TileConfigUpdateContext.Provider value={onUpdate}>
      {children}
    </TileConfigUpdateContext.Provider>
  );
}

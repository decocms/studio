import { useQuery } from "@tanstack/react-query";
import {
  useConnections,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { useRegistryConnections } from "@/web/hooks/use-binding";
import {
  callRegistryTool,
  extractItemsFromResponse,
  findListToolName,
} from "@/web/utils/registry-utils";
import { KEYS } from "@/web/lib/query-keys";
import type { RegistryItem } from "@/web/components/store/types";
import {
  findMatchingConnections,
  resolveInitialPhase,
  type SlotPhase,
} from "./slot-resolution";

export interface ConnectionSlot {
  label: string;
  registry: string;
  item_id: string;
}

export interface SlotResolution {
  initialPhase: SlotPhase;
  registryItem: RegistryItem | null;
  matchingConnections: ConnectionEntity[];
  satisfiedConnection: ConnectionEntity | null;
  isLoading: boolean;
  registryError: string | null;
}

export function useSlotResolution(slot: ConnectionSlot): SlotResolution {
  const { org } = useProjectContext();
  const allConnections = useConnections();
  const registryConnections = useRegistryConnections(allConnections);

  const registryConn = registryConnections.find(
    (c) => c.id === slot.registry || c.app_name === slot.registry,
  );

  const { data: registryItem, isLoading: isLoadingItem } = useQuery({
    queryKey: KEYS.registryItem(slot.registry, slot.item_id),
    queryFn: async (): Promise<RegistryItem | null> => {
      if (!registryConn) return null;
      const listTool = findListToolName(registryConn.tools);
      if (!listTool) return null;
      const result = await callRegistryTool<unknown>(
        registryConn.id,
        org.id,
        listTool,
        { where: { id: slot.item_id } },
      );
      const items = extractItemsFromResponse<RegistryItem>(result);
      return items[0] ?? null;
    },
    enabled: Boolean(registryConn && org),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoadingItem) {
    return {
      initialPhase: "loading",
      registryItem: null,
      matchingConnections: [],
      satisfiedConnection: null,
      isLoading: true,
      registryError: null,
    };
  }

  const matchingConnections = findMatchingConnections(
    allConnections,
    slot.item_id,
  );
  const satisfiedConnection =
    matchingConnections.find((c) => c.status === "active") ?? null;

  const registryError = !registryConn
    ? "Registry connection not found."
    : !registryItem
      ? "Registry item not found."
      : null;

  const initialPhase = resolveInitialPhase(allConnections, slot.item_id);

  return {
    initialPhase,
    registryItem: registryItem ?? null,
    matchingConnections,
    satisfiedConnection,
    isLoading: false,
    registryError,
  };
}

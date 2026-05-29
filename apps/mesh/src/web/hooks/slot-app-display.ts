/**
 * Decides how to display one of an agent's unresolved typed slots in the
 * connect gate. A slot carries only `slot_app_id`; when the registry knows the
 * app we show its friendly name + icon and allow inline connect, otherwise we
 * fall back to the raw app_id (synthetic `url:`/`stdio:`/`npx:` ids, or unknown
 * apps), which can only be connected via the connections page.
 */
import type { RegistryItem } from "@/web/components/store/types";
import { MCP_MESH_DECOCMS_KEY } from "@/web/utils/constants";

export interface SlotAppDisplay {
  kind: "registry" | "fallback";
  title: string;
  icon: string | null;
}

export function slotAppDisplay(
  slotAppId: string,
  item: RegistryItem | null,
): SlotAppDisplay {
  if (!item) {
    return { kind: "fallback", title: slotAppId, icon: null };
  }
  const meshMeta = item._meta?.[MCP_MESH_DECOCMS_KEY];
  const title =
    meshMeta?.friendlyName ||
    meshMeta?.friendly_name ||
    item.title ||
    item.server?.title ||
    item.server?.name ||
    slotAppId;
  const icon = item.server?.icons?.[0]?.src ?? null;
  return { kind: "registry", title, icon };
}

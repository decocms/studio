import { useOrgFlag } from "@/hooks/use-organization-settings";

/** Whether the org opted into the redesigned blocks editor. */
export function useNewBlocksEditor(): boolean {
  return useOrgFlag("new_blocks_editor");
}

/**
 * Whether a project is a Blocks v8 site, for every web v8 gate: its "Blocks
 * v8 site" switch (`isBlocksV8Project`), which only an org admin turns on, in
 * project settings. It decides every editor mode alike (GitHub, Sandbox and
 * Localhost) and every hosted screen (Experiments, Calendar, Releases, site
 * tokens, Monitor). Nothing reads main's schema, a working tree, a `deco
 * serve`'s schema or git for it. Off, the project is v7, as on main.
 *
 * The answer is synchronous: the project row is already read (suspense), so
 * no screen waits on it or shows one generation before the other.
 */

import { isBlocksV8Project } from "@decocms/shared/blocks-major";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useVirtualMCP } from "@/sdk";

/** The switch of a project in hand (pure; never suspends, for the sidebar). */
export function blocksV8Project(
  project: VirtualMCPEntity | null | undefined,
): boolean {
  return isBlocksV8Project(project?.metadata);
}

/** The switch of the project with this id (`false` with no id). */
export function useBlocksV8Project(
  virtualMcpId: string | null | undefined,
): boolean {
  return blocksV8Project(useVirtualMCP(virtualMcpId));
}

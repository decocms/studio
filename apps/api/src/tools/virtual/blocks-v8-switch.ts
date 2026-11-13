/**
 * The project's "Blocks v8 site" switch (`metadata.blocksV8`, read by
 * `isBlocksV8Project`): the one source of truth for every v8 gate. Only an
 * org owner or admin flips it, with `blocksV8` on
 * `COLLECTION_VIRTUAL_MCP_UPDATE` (what the project settings' CMS tab
 * sends). Every other client write of the key is refused, and nothing on
 * the server derives it (`deco schema push` is refused while it is off).
 */

import {
  BLOCKS_V8_METADATA_KEY,
  isBlocksV8Project,
} from "@decocms/shared/blocks-major";
import { hasAdminRole } from "@decocms/shared/auth/roles";
import { ForbiddenError } from "../../core/access-control";
import type { StudioContext } from "../../core/studio-context";

/** Turning the switch on or off is an org owner/admin action. */
export function requireOrgAdminForBlocksV8Switch(ctx: StudioContext): void {
  if (!hasAdminRole(ctx.access.getRole())) {
    throw new ForbiddenError(
      'Only organization owners and admins can turn "Blocks v8 site" on or off',
    );
  }
}

/**
 * Refuses a client metadata write that would set or clear the switch: it is
 * flipped only with `blocksV8`, by an org admin. A write that echoes the
 * stored value (a settings form sending back the metadata it read) passes;
 * the key is then stripped like the other server-managed ones.
 */
export function refuseBlocksV8MetadataWrite(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): void {
  if (!incoming || !Object.hasOwn(incoming, BLOCKS_V8_METADATA_KEY)) return;
  if (isBlocksV8Project(incoming) === isBlocksV8Project(existing)) return;
  throw new ForbiddenError(
    `metadata.${BLOCKS_V8_METADATA_KEY} is the "Blocks v8 site" switch: an organization owner or admin sets it with \`blocksV8\` (project settings, CMS), never through metadata`,
  );
}

/**
 * The single-key metadata patch that turns the switch `on` or off, or null
 * when it already is.
 */
export function blocksV8SwitchPatch(
  existing: Record<string, unknown> | null | undefined,
  on: boolean,
): { set: Record<string, unknown>; unset: string[] } | null {
  if (isBlocksV8Project(existing) === on) return null;
  return on
    ? { set: { [BLOCKS_V8_METADATA_KEY]: true }, unset: [] }
    : { set: {}, unset: [BLOCKS_V8_METADATA_KEY] };
}

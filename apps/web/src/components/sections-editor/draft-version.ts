import { cmsBlockVersion } from "./cms-api";

/**
 * A block's version in Studio's hosted draft, computed from the block
 * itself, as the server computes it: the first 16 bytes of
 * `sha256(canonicalJson(block))` in base64url (`cmsBlockVersion`).
 *
 * An editor that keeps its own copy guards each save by the version of the
 * copy it shows, so the guard can never be paired with a newer version read
 * separately (the draft's changes and the blocks are cached apart): a copy
 * the draft no longer holds is refused and reconciled, never written over
 * what it doesn't show.
 */
export function draftVersionOf(block: unknown): Promise<string> {
  return cmsBlockVersion(block);
}

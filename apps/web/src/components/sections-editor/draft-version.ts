import { serializeBlock } from "@decocms/blocks/protocol";

/**
 * A block's version in Studio's hosted draft, computed from the block
 * itself, as the server computes it: the git blob id (sha1 over `blob
 * <byte length>\0<text>`) of the block's stored text (`serializeBlock`).
 *
 * An editor that keeps its own copy guards each save by the version of the
 * copy it shows, so the guard can never be paired with a newer version read
 * separately (the draft's changes and the blocks are cached apart): a copy
 * the draft no longer holds is refused and reconciled, never written over
 * what it doesn't show.
 */
export async function draftVersionOf(block: unknown): Promise<string> {
  const text = new TextEncoder().encode(serializeBlock(block));
  const header = new TextEncoder().encode(`blob ${text.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + text.byteLength);
  bytes.set(header, 0);
  bytes.set(text, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

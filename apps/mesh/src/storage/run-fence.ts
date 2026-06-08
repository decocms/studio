/**
 * Single-writer fence (Phase A). The current fence token for a run lives on
 * `threads.run_fence_token`. An append from the desktop is accepted only when
 * the presented token is current. A null current means no fence has been minted
 * yet (minting lands in a later phase), so writes are accepted.
 */
export function fenceMatches(
  current: string | null,
  presented: string | null,
): boolean {
  if (current === null) return true;
  return current === presented;
}

/**
 * Maps a page's editable sections onto the top-level `<section
 * data-manifest-key>` nodes the runtime rendered, in order.
 *
 * Both sides skip: the runtime injects framework sections (SEO, Theme,
 * Analytics) around and between the editable ones, and an editable section can
 * render no node at all (an unwrapped Lazy, a streaming boundary, a matcher
 * that missed). A section only takes a node whose key it could have rendered;
 * otherwise it stays unmapped, because a mismapped section edits the wrong
 * component. Exact matches outscore wildcards.
 *
 * `candidates[i] === null` = renders nothing by construction; stays null so
 * positions still index the decofile array.
 *
 * Must stay self-contained: its source is stringified into CMS_EDITOR_SCRIPT
 * and evaluated in the iframe, where no module scope exists.
 *
 * @returns per candidate: the index into `domKeys`, or null.
 */
export function alignSections(
  candidates: (string[] | null)[],
  domKeys: (string | null)[],
): (number | null)[] {
  const result: (number | null)[] = candidates.map(() => null);
  const visible: number[] = [];
  for (let v = 0; v < candidates.length; v++) {
    if (candidates[v] !== null) visible.push(v);
  }
  const n = visible.length;
  const m = domKeys.length;
  if (!n || !m) return result;

  // A section may only take a node it plausibly rendered. 0 = not assignable.
  const score = (sectionIdx: number, nodeIdx: number): number => {
    const keys = candidates[visible[sectionIdx] ?? 0];
    if (!keys || !keys.length) return 1; // wildcard: matches, but outranked
    return keys.indexOf(domKeys[nodeIdx] ?? "") >= 0 ? 2 : 0;
  };

  /**
   * dp[i][j]: best score aligning the first i sections with the first j nodes.
   * move: 1 = section i-1 takes node j-1, 0 = node j-1 is a framework node,
   * 2 = section i-1 rendered nothing.
   */
  const dp: number[][] = [];
  const move: number[][] = [];
  for (let r = 0; r <= n; r++) {
    dp.push(new Array(m + 1).fill(0));
    move.push(new Array(m + 1).fill(2));
  }
  for (let i = 1; i <= n; i++) {
    const prevRow = dp[i - 1] ?? [];
    const row = dp[i] ?? [];
    const moveRow = move[i] ?? [];
    for (let j = 1; j <= m; j++) {
      let best = prevRow[j] ?? 0;
      let mv = 2;
      const skipNode = row[j - 1] ?? 0;
      if (skipNode > best) {
        best = skipNode;
        mv = 0;
      }
      const s = score(i - 1, j - 1);
      const take = (prevRow[j - 1] ?? 0) + s;
      if (s > 0 && take > best) {
        best = take;
        mv = 1;
      }
      row[j] = best;
      moveRow[j] = mv;
    }
  }

  let assigned = 0;
  let a = n;
  let b = m;
  while (a > 0 && b > 0) {
    const mv = move[a]?.[b] ?? 2;
    if (mv === 1) {
      result[visible[a - 1] ?? 0] = b - 1;
      assigned++;
      a--;
      b--;
    } else if (mv === 0) {
      b--;
    } else {
      a--;
    }
  }

  // No key matched: fall back to position only when the counts are unambiguous.
  if (assigned === 0 && m === n) {
    for (let p = 0; p < n; p++) result[visible[p] ?? 0] = p;
  }
  return result;
}

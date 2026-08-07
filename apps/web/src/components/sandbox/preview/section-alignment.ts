/**
 * Best in-order mapping of a page's editable sections onto the top-level
 * `<section data-manifest-key>` nodes the site runtime actually rendered.
 *
 * Both sides can hold entries the other lacks, so BOTH are skippable:
 *  - the runtime injects framework sections (SEO, Theme, Analytics, Session)
 *    that may lead, trail, OR interleave with the editable run;
 *  - an editable section can render NO top-level node at all — a Lazy /
 *    SingleDeferred that TanStack unwraps (the classic runtime keeps the
 *    wrapper `<section>`, TanStack renders the inner section directly, so
 *    before it resolves there is nothing in the DOM), a section still behind a
 *    streaming boundary, or a matcher that didn't hit.
 *
 * A node is only ever handed to a section whose candidate keys actually match
 * it. Requiring every section to claim some node — the previous behaviour —
 * meant one section rendering nothing shifted every section below it by one, so
 * clicking a component opened its neighbour's props, silently, and worst on
 * TanStack, the runtime that drops the wrapper node. An unmapped section costs
 * a click that does nothing; a mismapped one edits the wrong component.
 *
 * Exact key matches outscore wildcards so a multivariate — whose rendered key
 * we can't predict — doesn't steal a node an exact match wants.
 *
 * `candidates[i] === null` means the section renders nothing by construction
 * (every variant gated by a `never` matcher); it is dropped from the alignment
 * and stays null, so returned positions still index the decofile array.
 *
 * SELF-CONTAINED BY CONSTRUCTION: this function's source is stringified into
 * `CMS_EDITOR_SCRIPT` and evaluated inside the preview iframe, so its body must
 * never reference an import, a module-level constant, or anything else outside
 * itself. Keep it pure — that is also what makes it unit-testable.
 *
 * @returns one entry per `candidates` entry: the index into `domKeys`, or null
 *   when that section has no node in the DOM.
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

  // dp[i][j]: best score aligning the first i sections with the first j nodes.
  // move: 1 = section i-1 takes node j-1, 0 = node j-1 is a framework node,
  // 2 = section i-1 rendered nothing.
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

  // Nothing matched at all: the runtime evidently names its nodes on a
  // convention the decofile doesn't share, so key matching carries no signal.
  // Fall back to a positional mapping ONLY when the counts line up exactly,
  // which makes position unambiguous; otherwise leave every section unmapped
  // rather than guess and open the wrong props.
  if (assigned === 0 && m === n) {
    for (let p = 0; p < n; p++) result[visible[p] ?? 0] = p;
  }
  return result;
}

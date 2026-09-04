export interface MainBreadcrumbIdentity {
  /** Stable semantic identity. It must not be derived from a localized label. */
  id: string;
}

export interface MainBreadcrumbAncestorTrail<
  Item extends MainBreadcrumbIdentity,
> {
  /** Distinct ancestors in outermost-to-innermost order. */
  all: readonly Item[];
  /** The nearest ancestor, always shown inline. */
  nearest: Item | undefined;
  /** Ancestors available from overflow while `nearest` is shown inline. */
  overflow: readonly Item[];
}

export interface MainBreadcrumbAncestorPresentation<
  Item extends MainBreadcrumbIdentity,
> {
  /** Static ancestor shown inline when no route contributes a nearer parent. */
  inline: Item | undefined;
  /** Static ancestors kept navigable from the compact overflow menu. */
  overflow: readonly Item[];
}

/**
 * Derive the inline parent and stable overflow from one semantic ancestor list.
 *
 * Scope/current identities cannot also be ancestors. For a duplicate ancestor
 * id, the innermost occurrence wins because callers order the input from the
 * outermost ancestor to the nearest. Labels never participate: they can be
 * localized or legitimately identical across different entities.
 */
export function resolveMainBreadcrumbAncestorTrail<
  Item extends MainBreadcrumbIdentity,
>(
  scopeId: string,
  ancestors: readonly Item[],
  currentId: string,
): MainBreadcrumbAncestorTrail<Item> {
  const seenIds = new Set([scopeId, currentId]);
  const innermostFirst: Item[] = [];

  for (let index = ancestors.length - 1; index >= 0; index--) {
    const item = ancestors[index];
    if (!item || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    innermostFirst.push(item);
  }

  const all = innermostFirst.reverse();
  const nearest = all.at(-1);

  return {
    all,
    nearest,
    overflow: nearest ? all.slice(0, -1) : [],
  };
}

/**
 * Place static ancestors around an optional route-contributed parent.
 * A dynamic parent is always nearest, so every static ancestor moves into the
 * overflow without duplicating the contributed link or the current page.
 */
export function resolveMainBreadcrumbAncestorPresentation<
  Item extends MainBreadcrumbIdentity,
>(
  scopeId: string,
  ancestors: readonly Item[],
  currentId: string,
  dynamicParentPresent: boolean,
): MainBreadcrumbAncestorPresentation<Item> {
  const trail = resolveMainBreadcrumbAncestorTrail(
    scopeId,
    ancestors,
    currentId,
  );
  return dynamicParentPresent
    ? { inline: undefined, overflow: trail.all }
    : { inline: trail.nearest, overflow: trail.overflow };
}

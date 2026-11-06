/**
 * A post's identity, apart from its storage.
 *
 * One lifecycle post takes two physical block shapes — see `PostForm` in
 * `blog-data.ts` — and the `<id>` is the only thing both share. Routing,
 * remount keys, and deep links all address a post by that id, so a status
 * change that moves the block never invalidates a link to it.
 *
 * Its own module because the router needs these four values to resolve a
 * `/blog/posts/$postId` URL, and `blog-data.ts` is the whole blog data layer.
 */

/**
 * Planning posts (draft / generating / awaiting_review / archived) live one
 * block each under this prefix, carrying NO `__resolveType` — exactly like
 * themes, so the site's blog app never resolves an unfinished draft. Only when
 * a post is scheduled is it promoted to a real `collections/blog/posts/<id>`
 * block the site renders.
 */
export const PLANNING_POST_KEY_PREFIX = "blog-manager/posts/";

/** True when a key points at a planning post — anything but scheduled/published. */
export function isPlanningPostKey(key: string): boolean {
  return key.startsWith(PLANNING_POST_KEY_PREFIX);
}

/** The `<id>` shared by a post's planning and live forms — the last path segment. */
export function postIdOfKey(key: string): string {
  return key.split("/").pop() ?? key;
}

export function planningPostKey(id: string): string {
  return `${PLANNING_POST_KEY_PREFIX}${id}`;
}

export function livePostKey(id: string): string {
  return `collections/blog/posts/${id}`;
}

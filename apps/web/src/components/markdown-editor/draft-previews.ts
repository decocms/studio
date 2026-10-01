// A file name arrives with its brackets escaped (see `escapeLinkText`).
const PREVIEW_LINK = /!?\[(?:\\.|[^\\\]])*\]\((blob:[^)\s]+)\)/g;

/**
 * A draft's markdown without the previews it no longer holds. An undo after a
 * send can bring one back, and a `blob:` URL means nothing to anyone else.
 */
export function withoutDeadPreviews(
  markdown: string,
  live: { has: (url: string) => boolean },
): string {
  return markdown.replace(PREVIEW_LINK, (link, url: string) =>
    live.has(url) ? link : "",
  );
}

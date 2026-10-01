/**
 * A file name as a markdown link's text, and back. Left as is, a `*`, `_` or
 * bracket in the name would format the link or cut it short wherever it renders.
 */
const SPECIAL = /[\\`*_~[\]<&]/g;
const ESCAPED = /\\([!-/:-@[-`{-~])/g;

export function escapeLinkText(text: string): string {
  return text.replace(SPECIAL, "\\$&");
}

/** Marked leaves most escapes in a link token's `text`. */
export function unescapeLinkText(text: string): string {
  return text.replace(ESCAPED, "$1");
}

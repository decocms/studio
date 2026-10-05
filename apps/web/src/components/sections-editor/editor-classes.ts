/**
 * Styling shared by every TipTap surface in the CMS. The editors render raw
 * HTML with no typography plugin installed, so anything an author needs to
 * *recognize* while editing has to be spelled out here.
 */

/**
 * Anchors styled so an author can spot a link anywhere it lives — paragraph,
 * list item, table cell. Colour plus underline alone read as body copy, hence
 * the faint chip behind the text. The site renders its own link style.
 */
export const EDITOR_LINK_CLASS =
  "[&_a]:cursor-pointer [&_a]:text-primary [&_a]:underline [&_a]:decoration-primary/60 " +
  "[&_a]:underline-offset-2 [&_a]:rounded-sm [&_a]:bg-primary/5 [&_a]:px-0.5";

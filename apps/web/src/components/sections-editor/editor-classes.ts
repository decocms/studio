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

/**
 * The Placeholder extension only sets `data-placeholder` on an empty paragraph.
 * No stylesheet draws it, so an editor that wants the hint spells it out here.
 */
export const EDITOR_PLACEHOLDER_CLASS = [
  "[&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
  "[&_p.is-editor-empty:first-child::before]:text-muted-foreground/40",
  "[&_p.is-editor-empty:first-child::before]:float-left",
  "[&_p.is-editor-empty:first-child::before]:h-0",
  "[&_p.is-editor-empty:first-child::before]:pointer-events-none",
].join(" ");

/**
 * Block structure an author picks from the toolbar — heading levels, lists,
 * quotes. Tailwind's preflight renders `h2` and `ul` like a paragraph, so
 * without these a "Título 2" looks identical to the text around it.
 */
export const EDITOR_BLOCK_CLASS = [
  "[&>*:first-child]:mt-0 [&_p]:my-3",
  "[&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-3xl [&_h1]:font-bold",
  "[&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-2xl [&_h2]:font-bold",
  "[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-xl [&_h3]:font-bold",
  "[&_h4]:mb-2 [&_h4]:mt-4 [&_h4]:text-lg [&_h4]:font-bold",
  "[&_h5]:mb-2 [&_h5]:mt-4 [&_h5]:text-base [&_h5]:font-bold",
  "[&_h6]:mb-2 [&_h6]:mt-4 [&_h6]:text-sm [&_h6]:font-bold",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li>p]:my-1",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_strong]:font-bold",
].join(" ");

/**
 * Studio's modules for the site iframe: code of the site editor that runs
 * inside a Blocks v8 site's page, loaded through the page's Studio channel
 * (`./channel.ts`, vendored from `@decocms/blocks/protocol`). Studio hosts
 * them on its own origin at a versioned URL ({@link studioModuleUrl}); the
 * preview asks the page for both once it says `deco:ready`.
 *
 * - `wireframe`: outlines the page's editable sections on hover, reports the
 *   hovered and the clicked one, and keeps the page from navigating away
 *   while the Blocks panel edits it.
 * - `html-swap`: after a save, fetches the page's new HTML and swaps the
 *   document inside a View Transition (at once where the API is missing),
 *   reporting start and end, so the preview's progress bar tracks the swap.
 *
 * Every message type is the module's name, `:`, the message.
 */
/** The modules' message format; a breaking change moves every URL to a new version. */
export const STUDIO_MODULES_VERSION = "v1";

/** Where Studio serves the modules, on its own origin. */
export const STUDIO_MODULES_PATH = "/studio-modules";

export const STUDIO_MODULE_NAMES = ["wireframe", "html-swap"] as const;

export type StudioModuleName = (typeof STUDIO_MODULE_NAMES)[number];

/**
 * A module's absolute URL: `<studio>/studio-modules/v1/<name>.js`, with
 * Studio's build version as the query, so a deploy reaches pages at once
 * (the page imports a URL once per document).
 */
export function studioModuleUrl(
  studioOrigin: string,
  name: StudioModuleName,
  build: string,
): string {
  const url = new URL(
    `${STUDIO_MODULES_PATH}/${STUDIO_MODULES_VERSION}/${name}.js`,
    studioOrigin,
  );
  if (build) url.searchParams.set("build", build);
  return url.href;
}

/** A section's kind, which picks its outline's color. */
export type WireframeSectionKind = "normal" | "global" | "variant";

/** Studio → wireframe. */
export type WireframeIn =
  /** The Blocks panel edits the page: outline sections, block navigation. */
  | { type: "wireframe:activate" }
  /** The Blocks panel closed: the page is the page again. */
  | { type: "wireframe:deactivate" }
  /**
   * The page's editable sections, indexed like the page's sections array:
   * each one's label (a saved section's name, `""` for the DOM's own), kind,
   * and the manifest keys it may render (`[]` any, `null` none), which align
   * them within the DOM (`section-alignment.ts`).
   */
  | {
      type: "wireframe:sections";
      labels: string[];
      kinds: WireframeSectionKind[];
      keys: (string[] | null)[];
    }
  /** The pointer left the frame (a cross-origin frame can't see that itself). */
  | { type: "wireframe:clear-hover" }
  /**
   * A section picked in the Blocks panel: scroll it into view, smoothly, to
   * the middle of the frame (v7's `scrollToComponent`). Indexed like
   * `wireframe:sections`; a section the page doesn't render is ignored.
   */
  | { type: "wireframe:scroll-to"; sectionIndex: number };

/** Wireframe → Studio. */
export type WireframeOut =
  /** The section under the pointer, `null` for none. */
  | { type: "wireframe:hover"; sectionIndex: number | null }
  /** A click in a section. `clickSeq` counts clicks: two on one section are two selections. */
  | {
      type: "wireframe:select";
      sectionIndex: number;
      manifestKey: string;
      clickSeq: number;
    };

/** Studio → HTML swap. */
export type HtmlSwapIn =
  /**
   * Show the page's current content: fetch its HTML again and swap it in.
   * With `url` (a new URL of the page: a save moved the draft pointer in it),
   * that URL's HTML, on the page's own origin only; a later refresh without
   * one reads it again. The page's address stays as it loaded.
   */
  { type: "html-swap:refresh"; id: number; url?: string };

/** HTML swap → Studio, for the refresh `id`. A refresh superseded by a later one reports nothing. */
export type HtmlSwapOut =
  | { type: "html-swap:start"; id: number }
  | { type: "html-swap:end"; id: number }
  | { type: "html-swap:error"; id: number; message: string };

/** Every module message Studio sends or receives. */
export type StudioModuleMessage =
  | WireframeIn
  | WireframeOut
  | HtmlSwapIn
  | HtmlSwapOut;

/**
 * The DOM event HTML swap dispatches on `window` around a swap, for the other
 * modules in the page (the wireframe re-attaches its outline to the new body).
 */
export const HTML_SWAP_EVENT = "deco-studio:html-swap";

export interface HtmlSwapEventDetail {
  phase: "start" | "end";
}

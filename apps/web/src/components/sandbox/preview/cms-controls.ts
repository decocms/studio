/** The preview toolbar (URL bar, page picker) shows once something is
 *  servable: a ready sandbox daemon, production, or a connected `deco serve`'s
 *  app (`deco serve --preview`, v8), which never has a sandbox claim. A v7
 *  Local tunnel keeps the toolbar it had before: the daemon's. */
export function showPreviewToolbarFor(input: {
  previewSurfaceActive: boolean;
  daemonReady: boolean;
  production: boolean;
  servePreviewUrl: string | null | undefined;
}): boolean {
  return (
    input.previewSurfaceActive &&
    (input.daemonReady || input.production || !!input.servePreviewUrl)
  );
}

/** The page selector uses the exact same product gate as Content and Blocks. */
export function showCmsPageSelector(input: {
  showPreviewToolbar: boolean;
  contentEditingEnabled: boolean;
}): boolean {
  return input.showPreviewToolbar && input.contentEditingEnabled;
}

/** What activates the v7 CMS overlay script in the frame. */
export type CmsEditorActivation =
  | { type: "editor::inject"; args: { script: string } }
  | { type: "visual-editor::activate"; script: string };

/**
 * The message that activates the CMS overlay `script` in the frame, or `null`
 * for a Blocks v8 site: its page evaluates no script Studio sends (Studio's
 * code reaches it only through the Studio channel's modules). A v7
 * daemon-proxied sandbox speaks `visual-editor::activate`; a v7 Fast Preview
 * production frame and a Local tunnel (a raw deco runtime) speak the
 * framework's `editor::inject`.
 */
export function cmsEditorActivation(input: {
  v8: boolean;
  production: boolean;
  localPreview: boolean;
  script: string;
}): CmsEditorActivation | null {
  if (input.v8) return null;
  return input.production || input.localPreview
    ? { type: "editor::inject", args: { script: input.script } }
    : { type: "visual-editor::activate", script: input.script };
}

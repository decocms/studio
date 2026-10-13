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

/** The preview toolbar (URL bar, page picker) shows once something is
 *  servable: a ready sandbox daemon, production, or a local preview URL
 *  (deco serve --preview / tunnel), which never has a sandbox claim. */
export function showPreviewToolbarFor(input: {
  previewSurfaceActive: boolean;
  daemonReady: boolean;
  production: boolean;
  localPreviewUrl: string | null | undefined;
}): boolean {
  return (
    input.previewSurfaceActive &&
    (input.daemonReady || input.production || !!input.localPreviewUrl)
  );
}

/** The page selector uses the exact same product gate as Content and Blocks. */
export function showCmsPageSelector(input: {
  showPreviewToolbar: boolean;
  contentEditingEnabled: boolean;
}): boolean {
  return input.showPreviewToolbar && input.contentEditingEnabled;
}

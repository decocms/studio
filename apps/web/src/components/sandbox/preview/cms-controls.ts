/** The page selector uses the exact same product gate as Content and Blocks. */
export function showCmsPageSelector(input: {
  showPreviewToolbar: boolean;
  contentEditingEnabled: boolean;
}): boolean {
  return input.showPreviewToolbar && input.contentEditingEnabled;
}

/**
 * The preview toolbar (URL bar + page picker) needs something serving the
 * frame: the sandbox daemon, the production deployment, or — in Local mode —
 * the pasted dev server, which has no daemon behind it.
 */
export function showPreviewToolbar(input: {
  previewSurfaceActive: boolean;
  daemonReady: boolean;
  productionDisplay: boolean;
  localPreview: boolean;
}): boolean {
  return (
    input.previewSurfaceActive &&
    (input.daemonReady || input.productionDisplay || input.localPreview)
  );
}

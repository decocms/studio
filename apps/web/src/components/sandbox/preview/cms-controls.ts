/** The page selector uses the exact same product gate as Content and Blocks. */
export function showCmsPageSelector(input: {
  showPreviewToolbar: boolean;
  contentEditingEnabled: boolean;
}): boolean {
  return input.showPreviewToolbar && input.contentEditingEnabled;
}

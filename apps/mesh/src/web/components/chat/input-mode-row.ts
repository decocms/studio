export function shouldRenderInlineModeRow({
  messageCount,
  showConnectionsBanner,
}: {
  messageCount: number;
  showConnectionsBanner: boolean;
}): boolean {
  return messageCount > 0 || showConnectionsBanner;
}

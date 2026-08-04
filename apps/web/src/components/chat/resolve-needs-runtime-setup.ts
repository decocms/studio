/**
 * Pure core of `useNeedsRuntimeSetup` — see that hook for the semantics.
 * Extracted so the gate can be unit-tested without mounting the chat context.
 */
export function resolveNeedsRuntimeSetup({
  isThreadLocked,
  hasCloudProviderKeys,
}: {
  isThreadLocked: boolean;
  hasCloudProviderKeys: boolean;
}): boolean {
  // A routing-locked thread has already run and may have history. It must never
  // be replaced by the setup empty state, which would hide the conversation.
  // Setup only gates fresh, un-run threads.
  if (isThreadLocked) return false;

  return !hasCloudProviderKeys;
}

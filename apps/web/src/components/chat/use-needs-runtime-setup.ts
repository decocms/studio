import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { useOptionalChatTask } from "./context";
import { resolveNeedsRuntimeSetup } from "./resolve-needs-runtime-setup";

/**
 * True when there is no way to run a chat yet.
 *
 * Read only by the web chat side panel, which shows the provider setup empty
 * state for a fresh thread when the organization has no cloud provider key.
 * Native coding agents use the terminal runtime adapter and never reach this
 * structured-chat gate.
 */
export function useNeedsRuntimeSetup(): boolean {
  const allKeys = useHostedAiProviderKeys();
  const task = useOptionalChatTask();

  return resolveNeedsRuntimeSetup({
    isThreadLocked: task?.isThreadLocked ?? false,
    hasCloudProviderKeys: allKeys.length > 0,
  });
}

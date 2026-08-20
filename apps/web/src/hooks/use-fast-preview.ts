import { useSessionRuntime } from "./use-session-runtime";

/**
 * The Fast Preview gate for the CURRENT session — a thin read of
 * `useSessionRuntime`, kept while its call sites are migrated to that hook.
 *
 * `previewServerUrl` is returned alongside `active` because the callers that
 * need one almost always need the other: it is the origin a sandbox-less
 * session renders against.
 */
export function useFastPreview(virtualMcpId: string | null | undefined): {
  previewServerUrl: string | null;
  active: boolean;
} {
  const { runtime, previewServerUrl } = useSessionRuntime(virtualMcpId);
  return { previewServerUrl, active: runtime === "cms" };
}

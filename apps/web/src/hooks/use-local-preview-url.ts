import { sanitizeSiteUrl } from "@decocms/shared/deco-site-production-url";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

export interface LocalPreviewUrl {
  /** The active override, or `null` when Local mode is off / no project. Always
   *  a sanitized `http(s)` href — an unparseable stored value reads as off. */
  url: string | null;
  /** Turn Local mode on with a tunnel URL. A blank/invalid value clears it. */
  setUrl: (next: string | null) => void;
  /** Turn Local mode off (falls back to sandbox/production). */
  clear: () => void;
}

/**
 * The "Local" preview override: a tunnel URL the CMS `/live/_meta` reads and the
 * preview iframe render against, instead of the managed sandbox or the
 * production `previewServerUrl`. Selectable from the branch picker's Advanced
 * view; picking any branch/draft clears it.
 *
 * Per-browser (localStorage), per-project ({@link LOCALSTORAGE_KEYS.localPreviewUrl}):
 * a tunnel points at a dev server only this machine can reach, so it must never
 * land on shared project metadata where a teammate would inherit an unreachable
 * URL. Reading is reactive via `useLocalStorage` (same QueryClient cache), so
 * every surface flips together when it changes.
 */
export function useLocalPreviewUrl(
  virtualMcpId: string | null | undefined,
): LocalPreviewUrl {
  // Keyed unconditionally (hooks can't be conditional); no project reads as off.
  const key = LOCALSTORAGE_KEYS.localPreviewUrl(virtualMcpId ?? "");
  const [stored, setStored] = useLocalStorage<string | null>(key, null);
  const url = virtualMcpId ? sanitizeSiteUrl(stored) : null;
  return {
    url,
    setUrl: (next) => setStored(sanitizeSiteUrl(next)),
    clear: () => setStored(null),
  };
}

import { sanitizeSiteUrl } from "@decocms/shared/deco-site-production-url";
import { useLocalStorage } from "@/hooks/use-local-storage";
import {
  type MainSchemaAnswer,
  useMainSchemaV8,
} from "@/hooks/use-main-schema-v8";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

export interface LocalPreviewUrl {
  /** The active override, or `null` when Local mode is off / no project. Always
   *  a sanitized `http(s)` href — an unparseable stored value reads as off. */
  url: string | null;
  /**
   * A tunnel is saved but main's answer isn't known yet (loading, or
   * retrying after an error): it may be a v8 site, which never uses one.
   * `url` is null meanwhile, and the preview and the editor's reads wait,
   * as if the tunnel were there (no sandbox boots for it).
   */
  undecided: boolean;
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
 *
 * v7 only, as on main. A Blocks v8 site (main's schema, `useMainSchemaV8`)
 * reads as off: it previews the hosted draft, its sandbox or Localhost, so a
 * tunnel saved before (main's Advanced → Local, or before a v7 → v8 upgrade)
 * never replaces its preview or its editor. A saved tunnel waits for main's
 * answer (`undecided`): v7 then gets it as on main, after one cached read,
 * and a v8 site never shows it. Meanwhile nothing boots in its place.
 */
export function useLocalPreviewUrl(
  virtualMcpId: string | null | undefined,
): LocalPreviewUrl {
  // Keyed unconditionally (hooks can't be conditional); no project reads as off.
  const key = LOCALSTORAGE_KEYS.localPreviewUrl(virtualMcpId ?? "");
  const [stored, setStored] = useLocalStorage<string | null>(key, null);
  const main = useMainSchemaV8(virtualMcpId);
  const saved = virtualMcpId ? sanitizeSiteUrl(stored) : null;
  const state = localTunnelState({ saved, main });
  return {
    ...state,
    setUrl: (next) => setStored(sanitizeSiteUrl(next)),
    clear: () => setStored(null),
  };
}

/**
 * The tunnel in use from the saved one and main's answer: only on a site
 * known to be v7; undecided while main's answer isn't known (pure, tested).
 */
export function localTunnelState(input: {
  saved: string | null;
  main: MainSchemaAnswer;
}): { url: string | null; undecided: boolean } {
  if (!input.saved) return { url: null, undecided: false };
  if (input.main === "v7") return { url: input.saved, undecided: false };
  if (input.main === "v8") return { url: null, undecided: false };
  return { url: null, undecided: true };
}

/**
 * Pure parsers for the sandbox preview drawer's localStorage records. Kept free
 * of `localStorage` access so they can be unit-tested; the host components own
 * key building and the read/write calls. The `null`-vs-`false` distinction in
 * `parseTerminalOverride` is load-bearing: `null` (unset/malformed) is what
 * makes visibility fall back to the user's default preference, while an
 * explicit `false` is a per-VM "Hide" that overrides that default.
 */

export interface DrawerState {
  open: boolean;
  /** Open-drawer height in px; `null` = default (50% of the pane). */
  height: number | null;
}

/**
 * Parse a `preview-drawer:<id>` record. Tolerates the legacy height-less
 * `{ open }` shape (height → `null`) and any malformed/missing value.
 */
export function parseDrawerState(raw: string | null): DrawerState {
  if (!raw) return { open: false, height: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      open: !!parsed.open,
      height: typeof parsed.height === "number" ? parsed.height : null,
    };
  } catch {
    return { open: false, height: null };
  }
}

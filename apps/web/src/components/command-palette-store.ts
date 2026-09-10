/**
 * Whether the ⌘K palette is open — module-scope state, read with
 * `useSyncExternalStore`.
 *
 * The palette is OWNED by `shell-layout`: it renders the dialog, and it renders
 * it gated (`{open && <CommandPalette/>}`) because an always-mounted dialog
 * blanked the whole app. That ownership is worth keeping, but the openers are
 * not all in the shell — the org home's search box sits several lazy routes
 * below it, and the only alternatives were threading a prop through the panel
 * machinery or synthesising a ⌘K keydown, which fakes a user.
 *
 * A store beats a context provider here for one reason: a context whose value
 * is `[open, setOpen]` re-renders every consumer under the shell on each
 * toggle, and the consumers are the entire app. With a store, only the two
 * components that actually read `open` subscribe; `openCommandPalette()` is a
 * plain function any module can import without being under a provider at all.
 */

import { useSyncExternalStore } from "react";
import { Store } from "@/components/chat/store/store-primitive";

const paletteOpen = new Store(false);

/** Open the ⌘K palette from anywhere. */
export function openCommandPalette(): void {
  paletteOpen.set(true);
}

/**
 * Force it shut.
 *
 * The shell registers the ⌘K listener ABOVE the gates that can return an
 * access / archived / SSO screen instead of the shell, so the shortcut can set
 * this flag on a screen that never mounts the palette — and only the palette's
 * own `onOpenChange` writes `false`, so it latched: the next org you opened
 * showed a command palette nobody asked for. Module scope means it outlived
 * sign-out too.
 */
export function closeCommandPalette(): void {
  paletteOpen.set(false);
}

/** `useState`-shaped read of the palette's open flag, for the shell that renders it. */
export function useCommandPaletteOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(paletteOpen.subscribe, paletteOpen.get);
  return [open, paletteOpen.set];
}

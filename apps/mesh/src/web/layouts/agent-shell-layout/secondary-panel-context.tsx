/**
 * SecondaryPanelContext — a generic, feature-agnostic slot for a secondary
 * resizable column that the panel group renders between the chat and main
 * panels ([Chat | Secondary | Main]).
 *
 * The panel group owns the column chrome (card + drag divider + width) and
 * exposes `slotEl` as a portal target; a feature deep in the main panel flips
 * `open` and portals its content in — keeping that content in its own React
 * subtree (contexts/state intact) while the DOM lives in the column. Today the
 * only consumer is the sandbox preview's Sections (CMS) editor, but nothing
 * here is CMS-specific. `useSecondaryPanel()` returns null when there's no
 * provider (shells without a panel group, e.g. mobile), letting the consumer
 * fall back to inline rendering.
 */

import { createContext, use, useState, type ReactNode } from "react";

export interface SecondaryPanelCtx {
  /** Whether the secondary column should be shown in the panel group. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Portal target for the column's content, set by the panel group. */
  slotEl: HTMLDivElement | null;
  setSlotEl: (el: HTMLDivElement | null) => void;
}

const SecondaryPanelContext = createContext<SecondaryPanelCtx | null>(null);

export function SecondaryPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  return (
    <SecondaryPanelContext value={{ open, setOpen, slotEl, setSlotEl }}>
      {children}
    </SecondaryPanelContext>
  );
}

/** Null when rendered outside a provider (shells without a panel group). */
export function useSecondaryPanel(): SecondaryPanelCtx | null {
  return use(SecondaryPanelContext);
}

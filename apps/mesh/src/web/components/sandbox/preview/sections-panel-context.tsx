/**
 * SectionsPanelContext — lets the sandbox preview render its Sections (CMS)
 * editor into a dedicated resizable column that sits beside the preview at the
 * panel-group level ([Chat | CMS | Preview]), instead of nested inside the
 * preview tab.
 *
 * The preview keeps ownership of all CMS state (it drives the iframe overlays,
 * section selection, variant overrides, reloads); only the editor's DOM
 * location moves. The panel group renders the column when `open` and exposes
 * `slotEl` as the portal target; the preview flips `open` and portals its
 * editor in. When no provider is present (e.g. mobile, which has no panel
 * group) `useSectionsPanel()` returns null and the preview falls back to
 * rendering the editor inline.
 */

import { createContext, use, useState, type ReactNode } from "react";

export interface SectionsPanelCtx {
  /** Whether the CMS column should be shown in the panel group. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Column width in px (user-resizable via the drag divider). */
  width: number;
  setWidth: (width: number) => void;
  /** Portal target for the editor, set by the panel group's column. */
  slotEl: HTMLDivElement | null;
  setSlotEl: (el: HTMLDivElement | null) => void;
}

const SectionsPanelContext = createContext<SectionsPanelCtx | null>(null);

export function SectionsPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(384);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  return (
    <SectionsPanelContext
      value={{ open, setOpen, width, setWidth, slotEl, setSlotEl }}
    >
      {children}
    </SectionsPanelContext>
  );
}

/** Null when rendered outside a provider (shells without a panel group). */
export function useSectionsPanel(): SectionsPanelCtx | null {
  return use(SectionsPanelContext);
}

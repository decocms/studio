/** Where a preview's controls sit: a strip inside another surface (`bar`),
 *  the top of a surface of its own (`aside`), or the page's topbar. */
export type ToolbarPlacement = "bar" | "aside" | "topbar";

/** At the top of a surface they match the page header's own controls. */
export function toolbarButton(placement: ToolbarPlacement) {
  return placement === "bar"
    ? ({ variant: "ghost", size: "icon" } as const)
    : ({ variant: "secondary", size: "icon-sm" } as const);
}

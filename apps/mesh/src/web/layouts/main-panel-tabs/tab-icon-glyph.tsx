import { Package } from "@untitledui/icons";
import type { TabIcon } from "./resolve-tab-icon";

export function TabIconGlyph({ icon }: { icon: TabIcon }) {
  if (icon.kind === "component") {
    const { Component } = icon;
    return <Component className="size-4" />;
  }
  if (icon.kind === "url") {
    return (
      <img src={icon.src} alt="" className="size-4 rounded-sm object-cover" />
    );
  }
  return <Package className="size-4" />;
}

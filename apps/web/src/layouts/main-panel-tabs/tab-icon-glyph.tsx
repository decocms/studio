import { Package } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { TabIcon } from "./resolve-tab-icon";

export function TabIconGlyph({
  icon,
  className = "size-4",
}: {
  icon: TabIcon;
  /** Icon size/appearance. Defaults to `size-4` (16px). */
  className?: string;
}) {
  if (icon.kind === "component") {
    const { Component } = icon;
    return <Component className={className} />;
  }
  if (icon.kind === "url") {
    return (
      <img
        src={icon.src}
        alt=""
        className={cn(className, "rounded-sm object-cover")}
      />
    );
  }
  return <Package className={className} />;
}

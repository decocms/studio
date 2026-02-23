import { PropsWithChildren } from "react";
import {
  SidebarMenuItem,
  SidebarSeparator,
} from "@deco/ui/components/sidebar.tsx";

export function SidebarItemLayout({ children }: PropsWithChildren) {
  return (
    <>
      <SidebarSeparator className="my-2 -ml-1" />
      <SidebarMenuItem>
        <div className="group-data-[collapsible=icon]:hidden px-2 py-0 text-xs font-medium h-6 text-muted-foreground flex items-center justify-between">
          <span className="whitespace-nowrap">Pinned Views</span>
        </div>
      </SidebarMenuItem>
      {children}
    </>
  );
}

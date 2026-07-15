import { SidebarHeader } from "@deco/ui/components/sidebar.tsx";
import { ShellBreadcrumb } from "@/web/components/header/shell-breadcrumb";

/** Shared desktop sidebar identity row. */
export function SidebarSwitcherHeader() {
  return (
    <SidebarHeader className="desktop-wco-safe-header flex h-12 shrink-0 flex-row items-center overflow-hidden px-1 py-0 group-data-[state=expanded]/sidebar:pr-2">
      <ShellBreadcrumb placement="sidebar" />
    </SidebarHeader>
  );
}

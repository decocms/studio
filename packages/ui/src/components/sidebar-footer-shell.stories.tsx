import type { Meta, StoryObj } from "@storybook/react-vite";
import { DotsHorizontal } from "@untitledui/icons";
import { Avatar } from "./avatar.tsx";
import { Button } from "./button.tsx";
import { SidebarFooterShell } from "./sidebar-footer-shell.tsx";

const meta = {
  title: "Components/SidebarFooterShell",
  component: SidebarFooterShell,
  parameters: { layout: "padded" },
  // All stories use render(); children is only here to satisfy the required prop.
  args: { children: null },
} satisfies Meta<typeof SidebarFooterShell>;

export default meta;
type Story = StoryObj<typeof meta>;

function SidebarFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-60 rounded-lg border border-border bg-sidebar flex flex-col justify-end h-40">
      {children}
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <SidebarFrame>
      <SidebarFooterShell>
        <div className="flex items-center gap-2 p-2">
          <Avatar fallback="Maya Chen" shape="circle" size="xs" />
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-sm font-medium truncate">Maya Chen</span>
            <span className="text-xs text-muted-foreground truncate">
              maya@acme.com
            </span>
          </div>
          <Button variant="ghost" size="icon" aria-label="Account options">
            <DotsHorizontal />
          </Button>
        </div>
      </SidebarFooterShell>
    </SidebarFrame>
  ),
};

export const Loading: Story = {
  render: () => (
    <SidebarFrame>
      <SidebarFooterShell.Skeleton />
    </SidebarFrame>
  ),
};

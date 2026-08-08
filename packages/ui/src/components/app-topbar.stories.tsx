import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bell01, LayoutLeft, SearchMd } from "@untitledui/icons";
import { AppTopbar } from "./app-topbar.tsx";
import { Avatar } from "./avatar.tsx";
import { Button } from "./button.tsx";

const meta = {
  title: "Components/AppTopbar",
  component: AppTopbar,
  parameters: { layout: "fullscreen" },
  // All stories use render(); children is only here to satisfy the required prop.
  args: { children: null },
} satisfies Meta<typeof AppTopbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="h-48">
      <AppTopbar>
        <AppTopbar.Sidebar>
          <Button variant="ghost" size="icon" aria-label="Toggle sidebar">
            <LayoutLeft />
          </Button>
        </AppTopbar.Sidebar>
        <AppTopbar.Left>
          <div className="flex items-center gap-2 text-sm">
            <Avatar fallback="Acme Inc" size="xs" />
            <span className="font-medium">Acme Inc</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-muted-foreground">Storefront</span>
          </div>
        </AppTopbar.Left>
        <AppTopbar.Center>
          <span className="text-sm text-muted-foreground mx-auto">
            Production
          </span>
        </AppTopbar.Center>
        <AppTopbar.Right>
          <Button variant="ghost" size="icon" aria-label="Search">
            <SearchMd />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Notifications">
            <Bell01 />
          </Button>
          <Avatar fallback="Maya Chen" shape="circle" size="xs" />
        </AppTopbar.Right>
      </AppTopbar>
      <div className="pt-12 p-4 text-sm text-muted-foreground">
        Page content below the topbar
      </div>
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="h-48">
      <AppTopbar.Skeleton />
    </div>
  ),
};

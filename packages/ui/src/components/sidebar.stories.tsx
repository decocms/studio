import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Cube01,
  Dataflow03,
  Grid01,
  Home02,
  Link01,
  Settings01,
  Users01,
  Zap,
} from "@untitledui/icons";
import { Avatar } from "./avatar.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarLayout,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "./sidebar.tsx";

const meta = {
  title: "Components/Sidebar",
  component: Sidebar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

const platformItems = [
  { label: "Home", icon: Home02, active: false },
  { label: "Agents", icon: Cube01, active: true },
  { label: "Connections", icon: Link01, active: false },
  { label: "Workflows", icon: Dataflow03, active: false },
  { label: "Triggers", icon: Zap, active: false },
];

const organizationItems = [
  { label: "Members", icon: Users01, active: false },
  { label: "Apps", icon: Grid01, active: false },
  { label: "Settings", icon: Settings01, active: false },
];

function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 p-2">
          <Avatar fallback="Acme Inc" size="xs" />
          <span className="text-sm font-medium truncate group-data-[state=collapsed]/sidebar:hidden">
            Acme Inc
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {platformItems.map((item) => (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton
                    isActive={item.active}
                    tooltip={item.label}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>Organization</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {organizationItems.map((item) => (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton tooltip={item.label}>
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-2 p-2">
          <Avatar fallback="Maya Chen" shape="circle" size="xs" />
          <div className="flex flex-col min-w-0 group-data-[state=collapsed]/sidebar:hidden">
            <span className="text-sm font-medium truncate">Maya Chen</span>
            <span className="text-xs text-muted-foreground truncate">
              maya@acme.com
            </span>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function SidebarDemo({ defaultOpen }: { defaultOpen: boolean }) {
  return (
    <div className="h-screen">
      <SidebarProvider defaultOpen={defaultOpen}>
        <SidebarLayout>
          <AppSidebar />
          <SidebarInset>
            <header className="flex items-center gap-2 border-b border-border px-4 h-12">
              <SidebarTrigger />
              <span className="text-sm font-medium">Agents</span>
            </header>
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Page content
            </div>
          </SidebarInset>
        </SidebarLayout>
      </SidebarProvider>
    </div>
  );
}

export const Default: Story = {
  render: () => <SidebarDemo defaultOpen />,
};

export const Collapsed: Story = {
  render: () => <SidebarDemo defaultOpen={false} />,
};

export const Loading: Story = {
  render: () => (
    <div className="h-screen">
      <SidebarProvider defaultOpen>
        <SidebarLayout>
          <Sidebar>
            <SidebarHeader>
              <div className="flex items-center gap-2 p-2">
                <Avatar fallback="Acme Inc" size="xs" />
                <span className="text-sm font-medium">Acme Inc</span>
              </div>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {Array.from({ length: 6 }).map((_, index) => (
                      <SidebarMenuItem key={index}>
                        <SidebarMenuSkeleton showIcon />
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <SidebarInset>
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Page content
            </div>
          </SidebarInset>
        </SidebarLayout>
      </SidebarProvider>
    </div>
  ),
};

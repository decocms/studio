import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  BarChartSquare02,
  BookOpen01,
  ChevronDown,
  ChevronSelectorVertical,
  Columns03,
  Folder,
  Globe02,
  Home02,
  Inbox01,
  MessageCircle01,
  Plus,
  Rocket01,
  Settings02,
  Zap,
} from "@untitledui/icons";
import { Avatar } from "./avatar.tsx";
import { IconButton } from "./icon-button.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { TooltipProvider } from "./tooltip.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarLayout,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar.tsx";

const meta = {
  title: "Organisms/Sidebar",
  component: Sidebar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

/* Mirrors apps/web's StudioSidebar with default preferences: the classic nav,
   then the projects with their open tasks, then the account footer. */

const navItems = [
  { label: "Home", icon: Home02, active: true },
  { label: "Deco Score", icon: BarChartSquare02 },
  { label: "Board", icon: Columns03 },
  { label: "Library", icon: Folder },
  { label: "Settings", icon: Settings02 },
];

const projects = [
  {
    name: "Storefront",
    color: "blue" as const,
    icon: Globe02,
    tasks: ["Fix the checkout banner", "Alt text on product pages"],
  },
  { name: "Blog", color: "purple" as const, icon: BookOpen01, tasks: [] },
  { name: "Sales app", color: "green" as const, icon: Zap, tasks: [] },
];

function AppSidebar() {
  return (
    <Sidebar className="pt-1.5">
      <SidebarHeader className="h-12 flex-row items-center gap-1 px-2 py-0 group-data-[state=collapsed]/sidebar:h-auto group-data-[state=collapsed]/sidebar:flex-col">
        <button
          type="button"
          className="hover:bg-sidebar-accent focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-1.5 pl-2 group-data-[state=collapsed]/sidebar:flex-none group-data-[state=collapsed]/sidebar:p-0"
        >
          <Avatar fallback="Acme" size="xs" muted />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium group-data-[state=collapsed]/sidebar:hidden">
            Acme
          </span>
        </button>
        <SidebarTrigger className="group-data-[state=collapsed]/sidebar:mx-auto" />
        <IconButton
          label="New chat"
          className="group-data-[state=collapsed]/sidebar:hidden"
        >
          <MessageCircle01 />
        </IconButton>
      </SidebarHeader>
      <SidebarContent className="gap-6 px-2 pt-3 pb-2">
        <SidebarMenu className="gap-1">
          {navItems.map((item) => (
            <SidebarMenuItem key={item.label}>
              <SidebarMenuButton isActive={item.active} tooltip={item.label}>
                <item.icon />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <div className="flex flex-col gap-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-muted-foreground px-2 text-xs font-medium">
            Projects
          </p>
          <SidebarMenu className="gap-1">
            {projects.map((project) => (
              <SidebarMenuItem key={project.name}>
                <SidebarMenuButton tooltip={project.name}>
                  <ProjectIcon color={project.color} size="sm">
                    <project.icon />
                  </ProjectIcon>
                  <span>{project.name}</span>
                </SidebarMenuButton>
                {project.tasks.length > 0 && (
                  <ul className="flex flex-col">
                    {project.tasks.map((task, index) => (
                      <li key={task} className="relative">
                        <span
                          aria-hidden
                          className="border-sidebar-border absolute top-0 left-4 h-1/2 w-3 rounded-bl-lg border-b border-l"
                        />
                        {index < project.tasks.length - 1 && (
                          <span
                            aria-hidden
                            className="border-sidebar-border absolute top-1/2 bottom-0 left-4 border-l"
                          />
                        )}
                        <a
                          href="#task"
                          className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground flex h-8 items-center rounded-lg pr-2 pl-9 text-sm transition-colors"
                        >
                          <span className="truncate">{task}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </SidebarMenuItem>
            ))}
            <SidebarMenuItem>
              <SidebarMenuButton className="text-muted-foreground">
                <Plus />
                <span>Add project</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarContent>
      <SidebarFooter className="gap-0.5 px-2 pb-3">
        <div className="flex items-center gap-1 group-data-[state=collapsed]/sidebar:flex-col">
          <button
            type="button"
            className="hover:bg-sidebar-accent focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1.5"
          >
            <Avatar fallback="Maya Chen" shape="circle" size="xs" />
            <span className="min-w-0 flex-1 truncate text-left text-sm group-data-[state=collapsed]/sidebar:hidden">
              Maya Chen
            </span>
          </button>
          <IconButton label="Inbox">
            <Inbox01 />
          </IconButton>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function SidebarDemo({ defaultOpen }: { defaultOpen: boolean }) {
  return (
    <TooltipProvider>
      <div className="h-screen">
        <SidebarProvider defaultOpen={defaultOpen}>
          <SidebarLayout className="bg-sidebar">
            <AppSidebar />
            <SidebarInset className="m-1.5 ml-0 rounded-2xl shadow-edge">
              <header className="flex h-12 items-center gap-2 px-4">
                <span className="text-sm font-medium">Home</span>
              </header>
              <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
                Page content
              </div>
            </SidebarInset>
          </SidebarLayout>
        </SidebarProvider>
      </div>
    </TooltipProvider>
  );
}

/* The `projectFirstNav` preference: an org rail beside the sidebar, the
   destinations Today, Tasks, Agents and Library, and projects in folders. */

const orgs = [
  { name: "Acme", active: true },
  { name: "Casa Aurora" },
  { name: "Northwind" },
];

const destinations = [
  { label: "Today", icon: Home02, active: true },
  { label: "Tasks", icon: Columns03 },
  { label: "Agents", icon: Zap },
  { label: "Library", icon: Folder },
];

const folders = [
  {
    name: "Pinned",
    projects: [
      {
        name: "Storefront",
        color: "blue" as const,
        icon: Globe02,
        waiting: true,
      },
    ],
  },
  {
    name: "Marketing",
    projects: [
      { name: "Blog", color: "purple" as const, icon: BookOpen01 },
      { name: "Landing pages", color: "red" as const, icon: Rocket01 },
    ],
  },
];

function OrgRail() {
  return (
    <nav
      aria-label="Organizations"
      className="bg-sidebar flex w-16 shrink-0 flex-col items-center gap-1.5 pt-3 pb-2"
    >
      {orgs.map((org) => (
        <div key={org.name} className="relative flex w-full justify-center">
          {org.active && (
            <span
              aria-hidden
              className="bg-foreground absolute top-1.5 left-0 h-6 w-1 rounded-r-full"
            />
          )}
          <button
            type="button"
            aria-label={org.name}
            aria-current={org.active || undefined}
            className="focus-ring rounded-xl"
          >
            <Avatar fallback={org.name} muted size="base" className="size-9" />
          </button>
        </div>
      ))}
      <IconButton label="New organization" size="icon" className="size-9">
        <Plus />
      </IconButton>
    </nav>
  );
}

function ProjectFirstSidebar() {
  return (
    <Sidebar className="pt-1.5">
      <SidebarHeader className="h-12 flex-row items-center gap-1 px-2 py-0">
        <button
          type="button"
          className="hover:bg-sidebar-accent focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1.5 pr-1.5 pl-2 text-sm font-medium"
        >
          <span className="truncate">Acme</span>
          <ChevronSelectorVertical className="text-muted-foreground size-3.5" />
        </button>
        <SidebarTrigger />
        <IconButton label="New chat">
          <MessageCircle01 />
        </IconButton>
      </SidebarHeader>
      <SidebarContent className="gap-6 px-2 pt-3 pb-2">
        <SidebarMenu className="gap-1">
          {destinations.map((item) => (
            <SidebarMenuItem key={item.label}>
              <SidebarMenuButton isActive={item.active} tooltip={item.label}>
                <item.icon />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        {folders.map((folder) => (
          <div key={folder.name} className="flex flex-col gap-1">
            <div className="flex h-6 items-center gap-1 px-2">
              <span className="text-muted-foreground text-xs font-medium">
                {folder.name}
              </span>
              <ChevronDown className="text-muted-foreground size-3" />
            </div>
            <SidebarMenu className="gap-1">
              {folder.projects.map((project) => (
                <SidebarMenuItem key={project.name}>
                  <SidebarMenuButton tooltip={project.name}>
                    <ProjectIcon color={project.color} size="sm">
                      <project.icon />
                    </ProjectIcon>
                    <span className="flex-1">{project.name}</span>
                    {"waiting" in project && (
                      <span
                        aria-label="1 waiting on you"
                        className="bg-warning mr-1 size-2 rounded-full"
                      />
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </div>
        ))}
      </SidebarContent>
      <SidebarFooter className="px-2 pb-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="hover:bg-sidebar-accent focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1.5"
          >
            <Avatar fallback="Maya Chen" shape="circle" size="xs" />
            <span className="min-w-0 flex-1 truncate text-left text-sm">
              Maya Chen
            </span>
          </button>
          <IconButton label="Settings">
            <Settings02 />
          </IconButton>
          <IconButton label="Inbox">
            <Inbox01 />
          </IconButton>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

/** With the project-first preference on. */
export const ProjectFirst: Story = {
  render: () => (
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <div className="bg-sidebar flex h-screen w-full">
          <OrgRail />
          <SidebarLayout className="bg-sidebar flex-1">
            <ProjectFirstSidebar />
            <SidebarInset className="m-1.5 ml-0 rounded-2xl shadow-edge">
              <header className="flex h-12 items-center px-4">
                <span className="text-sm font-medium">Today</span>
              </header>
            </SidebarInset>
          </SidebarLayout>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  ),
};

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

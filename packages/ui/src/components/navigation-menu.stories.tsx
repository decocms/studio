import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from "./navigation-menu.tsx";

const meta = {
  title: "Components/NavigationMenu",
  component: NavigationMenu,
  parameters: { layout: "padded" },
} satisfies Meta<typeof NavigationMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex h-72 justify-center">
      <NavigationMenu>
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuTrigger>Product</NavigationMenuTrigger>
            <NavigationMenuContent>
              <div className="grid w-96 gap-1">
                <NavigationMenuLink href="#">
                  <span className="font-medium">Connections</span>
                  <span className="text-muted-foreground">
                    Link MCP servers to your workspace.
                  </span>
                </NavigationMenuLink>
                <NavigationMenuLink href="#">
                  <span className="font-medium">Agents</span>
                  <span className="text-muted-foreground">
                    Build and deploy agents with your tools.
                  </span>
                </NavigationMenuLink>
                <NavigationMenuLink href="#">
                  <span className="font-medium">Observability</span>
                  <span className="text-muted-foreground">
                    Trace every tool call end to end.
                  </span>
                </NavigationMenuLink>
              </div>
            </NavigationMenuContent>
          </NavigationMenuItem>
          <NavigationMenuItem>
            <NavigationMenuTrigger>Resources</NavigationMenuTrigger>
            <NavigationMenuContent>
              <div className="grid w-72 gap-1">
                <NavigationMenuLink href="#">
                  <span className="font-medium">Documentation</span>
                  <span className="text-muted-foreground">
                    Guides and API reference.
                  </span>
                </NavigationMenuLink>
                <NavigationMenuLink href="#">
                  <span className="font-medium">Changelog</span>
                  <span className="text-muted-foreground">
                    What shipped this week.
                  </span>
                </NavigationMenuLink>
              </div>
            </NavigationMenuContent>
          </NavigationMenuItem>
          <NavigationMenuItem>
            <NavigationMenuLink
              href="#"
              className={navigationMenuTriggerStyle()}
            >
              Pricing
            </NavigationMenuLink>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>
    </div>
  ),
};

export const WithoutViewport: Story = {
  render: () => (
    <div className="flex h-72 justify-center">
      <NavigationMenu viewport={false}>
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuTrigger>Workspace</NavigationMenuTrigger>
            <NavigationMenuContent>
              <div className="grid w-64 gap-1">
                <NavigationMenuLink href="#">Overview</NavigationMenuLink>
                <NavigationMenuLink href="#">Members</NavigationMenuLink>
                <NavigationMenuLink href="#">Settings</NavigationMenuLink>
              </div>
            </NavigationMenuContent>
          </NavigationMenuItem>
          <NavigationMenuItem>
            <NavigationMenuLink
              href="#"
              className={navigationMenuTriggerStyle()}
            >
              Docs
            </NavigationMenuLink>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>
    </div>
  ),
};

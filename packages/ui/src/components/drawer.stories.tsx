import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button.tsx";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer.tsx";

const meta = {
  title: "Components/Drawer",
  component: Drawer,
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline">Manage subscription</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Upgrade to Team plan</DrawerTitle>
          <DrawerDescription>
            Unlimited connections, 10 projects, and priority support for
            $50/month per organization.
          </DrawerDescription>
        </DrawerHeader>
        <DrawerFooter>
          <Button>Upgrade now</Button>
          <DrawerClose asChild>
            <Button variant="outline">Maybe later</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

export const Directions: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(["bottom", "top", "left", "right"] as const).map((direction) => (
        <Drawer key={direction} direction={direction}>
          <DrawerTrigger asChild>
            <Button variant="outline" className="capitalize">
              {direction}
            </Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Activity log</DrawerTitle>
              <DrawerDescription>
                This drawer slides in from the {direction} edge.
              </DrawerDescription>
            </DrawerHeader>
          </DrawerContent>
        </Drawer>
      ))}
    </div>
  ),
};

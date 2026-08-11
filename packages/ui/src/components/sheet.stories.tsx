import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet.tsx";

const meta = {
  title: "Components/Sheet",
  component: Sheet,
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Edit member</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit member</SheetTitle>
          <SheetDescription>
            Update the member's display name and role, then save.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 px-4">
          <div className="grid gap-2">
            <Label htmlFor="member-name">Name</Label>
            <Input id="member-name" defaultValue="Ana Souza" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="member-role">Role</Label>
            <Input id="member-role" defaultValue="Admin" />
          </div>
        </div>
        <SheetFooter>
          <Button>Save changes</Button>
          <SheetClose asChild>
            <Button variant="outline">Cancel</Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
};

export const Sides: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(["right", "left", "top", "bottom"] as const).map((side) => (
        <Sheet key={side}>
          <SheetTrigger asChild>
            <Button variant="outline" className="capitalize">
              {side}
            </Button>
          </SheetTrigger>
          <SheetContent side={side}>
            <SheetHeader>
              <SheetTitle>Connection details</SheetTitle>
              <SheetDescription>
                This panel slides in from the {side} edge of the screen.
              </SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      ))}
    </div>
  ),
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Calendar,
  Mail01,
  Plus,
  Settings01,
  User01,
  Users01,
} from "@untitledui/icons";
import { useState } from "react";
import { Button } from "./button.tsx";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command.tsx";

const meta = {
  title: "Components/Command",
  component: Command,
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Command className="w-96 rounded-lg border shadow-md">
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Suggestions">
          <CommandItem>
            <Plus /> New connection
          </CommandItem>
          <CommandItem>
            <Calendar /> Schedule a task
          </CommandItem>
          <CommandItem>
            <Mail01 /> Invite a member
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem>
            <User01 /> Profile
            <CommandShortcut>⇧⌘P</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <Users01 /> Members
            <CommandShortcut>⌘M</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <Settings01 /> Organization settings
            <CommandShortcut>⌘,</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};

function CommandDialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open command palette
        <span className="text-muted-foreground text-xs">⌘K</span>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Search projects, connections, members..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Projects">
            <CommandItem>Checkout service</CommandItem>
            <CommandItem>Storefront</CommandItem>
            <CommandItem>Internal tools</CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Connections">
            <CommandItem>Stripe</CommandItem>
            <CommandItem>Linear</CommandItem>
            <CommandItem>GitHub</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

export const AsDialog: Story = {
  render: () => <CommandDialogDemo />,
};

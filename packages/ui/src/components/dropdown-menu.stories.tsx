import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Copy01,
  LogOut01,
  Plus,
  Settings01,
  Trash01,
  User01,
  UserPlus01,
  Users01,
} from "@untitledui/icons";
import { useState } from "react";
import { Button } from "./button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

const meta = {
  title: "Components/DropdownMenu",
  component: DropdownMenu,
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Account</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>My account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <User01 /> Profile
            <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Settings01 /> Settings
            <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <Users01 /> Team
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <UserPlus01 className="mr-2 size-4" /> Invite members
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>
                <Copy01 /> Copy invite link
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Plus /> Invite by email
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <LogOut01 /> Log out
          <DropdownMenuShortcut>⇧⌘Q</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

export const DestructiveItem: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Connection actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52">
        <DropdownMenuItem>
          <Copy01 /> Duplicate connection
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Settings01 /> Edit configuration
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <Trash01 /> Delete connection
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

function CheckboxesDemo() {
  const [showTools, setShowTools] = useState(true);
  const [showResources, setShowResources] = useState(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">View options</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={showTools}
          onCheckedChange={setShowTools}
        >
          Tools
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={showResources}
          onCheckedChange={setShowResources}
        >
          Resources
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked disabled>
          Status
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const WithCheckboxItems: Story = {
  render: () => <CheckboxesDemo />,
};

function RadioGroupDemo() {
  const [sortBy, setSortBy] = useState("name");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Sort by</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48">
        <DropdownMenuLabel>Sort connections</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={sortBy} onValueChange={setSortBy}>
          <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="last-used">
            Last used
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">
            Date created
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const WithRadioGroup: Story = {
  render: () => <RadioGroupDemo />,
};

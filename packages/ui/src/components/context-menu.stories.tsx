import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu.tsx";

const meta = {
  title: "Components/ContextMenu",
  component: ContextMenu,
} satisfies Meta<typeof ContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger className="border-border text-muted-foreground flex h-40 w-80 items-center justify-center rounded-lg border border-dashed text-sm">
        Right-click here
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem>
          Open project
          <ContextMenuShortcut>⌘O</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          Rename
          <ContextMenuShortcut>⌘R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Share</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuItem>Copy link</ContextMenuItem>
            <ContextMenuItem>Invite teammate</ContextMenuItem>
            <ContextMenuItem>Export as JSON</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive">
          Delete project
          <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
};

function SelectionDemo() {
  const [pinned, setPinned] = useState(true);
  const [view, setView] = useState("grid");
  return (
    <ContextMenu>
      <ContextMenuTrigger className="border-border text-muted-foreground flex h-40 w-80 items-center justify-center rounded-lg border border-dashed text-sm">
        Right-click for view options
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>
          Pin to sidebar
        </ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuLabel inset>Layout</ContextMenuLabel>
        <ContextMenuRadioGroup value={view} onValueChange={setView}>
          <ContextMenuRadioItem value="grid">Grid</ContextMenuRadioItem>
          <ContextMenuRadioItem value="list">List</ContextMenuRadioItem>
          <ContextMenuRadioItem value="compact">Compact</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const WithSelectionItems: Story = {
  render: () => <SelectionDemo />,
};

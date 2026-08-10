import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy01, Edit01, Settings01, Trash01 } from "@untitledui/icons";
import { Button } from "./button.tsx";
import {
  ResponsiveDropdown,
  ResponsiveDropdownContent,
  ResponsiveDropdownItem,
  ResponsiveDropdownSeparator,
  ResponsiveDropdownTrigger,
} from "./responsive-dropdown.tsx";

const meta = {
  title: "Components/ResponsiveDropdown",
  component: ResponsiveDropdown,
} satisfies Meta<typeof ResponsiveDropdown>;

export default meta;
type Story = StoryObj<typeof meta>;

// Renders as a dropdown menu on desktop and as a bottom drawer on mobile
// viewports (resize the canvas below the mobile breakpoint to see it switch).
export const Default: Story = {
  render: () => (
    <ResponsiveDropdown>
      <ResponsiveDropdownTrigger asChild>
        <Button variant="outline">Project actions</Button>
      </ResponsiveDropdownTrigger>
      <ResponsiveDropdownContent title="Project actions" className="w-52">
        <ResponsiveDropdownItem>
          <Edit01 /> Rename project
        </ResponsiveDropdownItem>
        <ResponsiveDropdownItem>
          <Copy01 /> Duplicate project
        </ResponsiveDropdownItem>
        <ResponsiveDropdownItem>
          <Settings01 /> Project settings
        </ResponsiveDropdownItem>
        <ResponsiveDropdownSeparator />
        <ResponsiveDropdownItem variant="destructive">
          <Trash01 /> Delete project
        </ResponsiveDropdownItem>
      </ResponsiveDropdownContent>
    </ResponsiveDropdown>
  ),
};

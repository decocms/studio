import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SearchInput } from "./search-input.tsx";

const meta = {
  title: "Components/SearchInput",
  component: SearchInput,
  args: {
    value: "",
    onChange: () => {},
    placeholder: "Search connections...",
  },
} satisfies Meta<typeof SearchInput>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledDemo() {
  const [value, setValue] = useState("");
  return (
    <div className="w-72">
      <SearchInput
        value={value}
        onChange={setValue}
        placeholder="Search connections..."
      />
    </div>
  );
}

export const Default: Story = {
  render: () => <ControlledDemo />,
};

export const Searching: Story = {
  args: {
    value: "slack",
    isSearching: true,
  },
  render: (args) => (
    <div className="w-72">
      <SearchInput {...args} />
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <div className="w-72">
      <SearchInput {...args} />
    </div>
  ),
};

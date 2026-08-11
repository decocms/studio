import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CollectionSearch } from "./collection-search.tsx";

const meta = {
  title: "Components/CollectionSearch",
  component: CollectionSearch,
  parameters: { layout: "padded" },
  args: {
    value: "",
    onChange: () => {},
    placeholder: "Search agents...",
  },
} satisfies Meta<typeof CollectionSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledDemo() {
  const [value, setValue] = useState("");
  return (
    <div className="w-[640px] rounded-t-lg border border-b-0 border-border">
      <CollectionSearch
        value={value}
        onChange={setValue}
        placeholder="Search agents..."
      />
    </div>
  );
}

/** Full-width search bar used at the top of collection pages (Agents, Connections, Monitor). */
export const Default: Story = {
  render: () => <ControlledDemo />,
};

export const Searching: Story = {
  args: {
    value: "support",
    isSearching: true,
  },
  render: (args) => (
    <div className="w-[640px]">
      <CollectionSearch {...args} />
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <div className="w-[640px]">
      <CollectionSearch {...args} />
    </div>
  ),
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Badge } from "./badge.tsx";
import { Combobox, type ComboboxOption } from "./combobox.tsx";

const frameworks: ComboboxOption[] = [
  { value: "production", label: "Production" },
  { value: "staging", label: "Staging" },
  { value: "development", label: "Development" },
  { value: "preview", label: "Preview" },
];

const members: ComboboxOption[] = [
  { value: "ana", label: "Ana Souza", role: "Admin" },
  { value: "bruno", label: "Bruno Lima", role: "Member" },
  { value: "carla", label: "Carla Mendes", role: "Member" },
  { value: "diego", label: "Diego Santos", role: "Viewer" },
];

const meta = {
  title: "Components/Combobox",
  component: Combobox,
  args: {
    options: frameworks,
    value: "",
    onChange: () => {},
    placeholder: "Select environment...",
  },
} satisfies Meta<typeof Combobox>;

export default meta;
type Story = StoryObj<typeof meta>;

function DefaultDemo() {
  const [value, setValue] = useState("");
  return (
    <Combobox
      options={frameworks}
      value={value}
      onChange={setValue}
      placeholder="Select environment..."
      searchPlaceholder="Search environments..."
      emptyMessage="No environment found."
    />
  );
}

export const Default: Story = {
  render: () => <DefaultDemo />,
};

function PreselectedDemo() {
  const [value, setValue] = useState("production");
  return (
    <Combobox
      options={frameworks}
      value={value}
      onChange={setValue}
      width="w-[240px]"
    />
  );
}

export const Preselected: Story = {
  render: () => <PreselectedDemo />,
};

function CustomItemDemo() {
  const [value, setValue] = useState("ana");
  return (
    <Combobox
      options={members}
      value={value}
      onChange={setValue}
      width="w-[260px]"
      placeholder="Assign to..."
      searchPlaceholder="Search members..."
      emptyMessage="No member found."
      renderItem={(option, isSelected) => (
        <div className="flex w-full items-center justify-between gap-2">
          <span className={isSelected ? "font-medium" : undefined}>
            {option.label}
          </span>
          <Badge variant="outline">{String(option.role)}</Badge>
        </div>
      )}
    />
  );
}

export const CustomItemRendering: Story = {
  render: () => <CustomItemDemo />,
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";

const meta = {
  title: "Components/Input",
  component: Input,
  args: {
    placeholder: "Search connections...",
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-80 gap-2">
      <Label htmlFor="project-name">Project name</Label>
      <Input id="project-name" placeholder="my-storefront" />
    </div>
  ),
};

export const Types: Story = {
  render: () => (
    <div className="grid w-80 gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" placeholder="ana@example.com" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="url">Webhook URL</Label>
        <Input id="url" type="url" placeholder="https://example.com/hooks" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="seats">Seats</Label>
        <Input id="seats" type="number" defaultValue={5} min={1} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="avatar">Avatar</Label>
        <Input id="avatar" type="file" />
      </div>
    </div>
  ),
};

export const Invalid: Story = {
  render: () => (
    <div className="grid w-80 gap-2">
      <Label htmlFor="slug">Organization slug</Label>
      <Input id="slug" defaultValue="Acme Inc!" aria-invalid />
      <p className="text-sm text-destructive">
        Slugs can only contain lowercase letters, numbers, and dashes.
      </p>
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true, value: "conn_9f2e1c" },
};

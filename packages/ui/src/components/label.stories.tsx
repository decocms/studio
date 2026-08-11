import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./checkbox.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";

const meta = {
  title: "Components/Label",
  component: Label,
  args: {
    children: "Email address",
  },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithInput: Story = {
  render: () => (
    <div className="grid w-80 gap-2">
      <Label htmlFor="email">Email address</Label>
      <Input id="email" type="email" placeholder="ana@example.com" />
    </div>
  ),
};

export const WithCheckbox: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="marketing" />
      <Label htmlFor="marketing">Send me product updates</Label>
    </div>
  ),
};

export const WithDisabledPeer: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="sso" disabled />
      <Label htmlFor="sso">Require SSO (managed by your plan)</Label>
    </div>
  ),
};

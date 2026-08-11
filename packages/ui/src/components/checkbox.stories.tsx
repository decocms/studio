import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./checkbox.tsx";
import { Label } from "./label.tsx";

const meta = {
  title: "Components/Checkbox",
  component: Checkbox,
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { "aria-label": "Accept terms" },
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="terms" />
      <Label htmlFor="terms">Accept terms and conditions</Label>
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Checkbox id="unchecked" />
        <Label htmlFor="unchecked">Unchecked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="checked" defaultChecked />
        <Label htmlFor="checked">Checked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="disabled" disabled />
        <Label htmlFor="disabled">Disabled</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="disabled-checked" disabled defaultChecked />
        <Label htmlFor="disabled-checked">Disabled checked</Label>
      </div>
    </div>
  ),
};

export const SettingsGroup: Story = {
  render: () => (
    <div className="grid w-80 gap-3">
      <p className="text-sm font-medium text-foreground">Email notifications</p>
      <div className="flex items-start gap-2">
        <Checkbox id="invites" defaultChecked className="mt-0.5" />
        <div className="grid gap-1">
          <Label htmlFor="invites">Member invites</Label>
          <p className="text-sm text-muted-foreground">
            When someone invites a new member to the organization.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox id="deploys" defaultChecked className="mt-0.5" />
        <div className="grid gap-1">
          <Label htmlFor="deploys">Deploy activity</Label>
          <p className="text-sm text-muted-foreground">
            When a project deploy succeeds or fails.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox id="digest" className="mt-0.5" />
        <div className="grid gap-1">
          <Label htmlFor="digest">Weekly digest</Label>
          <p className="text-sm text-muted-foreground">
            A summary of usage across your projects.
          </p>
        </div>
      </div>
    </div>
  ),
};

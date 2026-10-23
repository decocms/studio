import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./checkbox.tsx";
import { Label } from "./label.tsx";
import { Matrix } from "../foundations/kit.tsx";

const meta = {
  title: "Atoms/Checkbox",
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

export const States: Story = {
  parameters: {
    controls: { disable: true },
    layout: "padded",
    pseudo: {
      hover: [".is-hover"],
      focusVisible: [".is-focus"],
      active: [".is-active"],
    },
  },
  render: () => (
    <Matrix
      columns={["Default", "Hover", "Focus", "Disabled"]}
      rows={(
        [
          ["Unchecked", false],
          ["Checked", true],
          ["Indeterminate", "indeterminate"],
        ] as const
      ).map(([label, checked]) => ({
        label,
        cells: ["", "is-hover", "is-focus", "disabled"].map((state) => (
          <Checkbox
            key={state}
            checked={checked}
            className={state}
            disabled={state === "disabled"}
            aria-label={label}
          />
        )),
      }))}
    />
  ),
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Label } from "./label.tsx";
import { PasswordInput } from "./password-input.tsx";

const meta = {
  title: "Components/PasswordInput",
  component: PasswordInput,
  args: {
    placeholder: "Enter your API key",
  },
} satisfies Meta<typeof PasswordInput>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledDemo() {
  const [value, setValue] = useState("a-very-secret-value");
  return (
    <div className="grid w-96 gap-2">
      <Label htmlFor="api-key">API key</Label>
      <PasswordInput
        id="api-key"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <p className="text-sm text-muted-foreground">
        Use the buttons to reveal or copy the token.
      </p>
    </div>
  );
}

export const Default: Story = {
  render: () => <ControlledDemo />,
};

export const Empty: Story = {
  render: () => (
    <div className="w-96">
      <PasswordInput value="" placeholder="Paste your access token" />
    </div>
  ),
};

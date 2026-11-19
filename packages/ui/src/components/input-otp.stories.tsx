import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { InputOtp } from "./input-otp.tsx";

const meta = {
  title: "Atoms/InputOtp",
  component: InputOtp,
  args: { length: 6 },
} satisfies Meta<typeof InputOtp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="w-80">
      <InputOtp {...args} />
    </div>
  ),
};

function AutoSubmitDemo() {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  return (
    <div className="grid w-80 gap-3">
      <InputOtp
        length={6}
        value={value}
        onChange={setValue}
        onComplete={setSubmitted}
      />
      <p className="text-sm text-muted-foreground">
        {submitted ? `Submitted ${submitted}` : "Fill every box"}
      </p>
    </div>
  );
}

export const AutoSubmit: Story = {
  render: () => <AutoSubmitDemo />,
};

export const Invalid: Story = {
  args: { "aria-invalid": true, defaultValue: "123456" },
  render: (args) => (
    <div className="w-80">
      <InputOtp {...args} />
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "123" },
  render: (args) => (
    <div className="w-80">
      <InputOtp {...args} />
    </div>
  ),
};

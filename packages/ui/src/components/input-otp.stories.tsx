import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "./input-otp.tsx";
import { Label } from "./label.tsx";

const meta = {
  title: "Components/InputOTP",
  component: InputOTP,
} satisfies Meta<typeof InputOTP>;

export default meta;
// OTPInput has required props (maxLength, children) supplied inside each
// render function, so stories are typed without meta-derived args.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <InputOTP maxLength={6}>
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>
  ),
};

export const WithSeparator: Story = {
  render: () => (
    <InputOTP maxLength={6}>
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>
  ),
};

function VerificationDemo() {
  const [code, setCode] = useState("");
  return (
    <div className="grid gap-2">
      <Label htmlFor="otp">Verification code</Label>
      <InputOTP id="otp" maxLength={6} value={code} onChange={setCode}>
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>
      <p className="text-sm text-muted-foreground">
        {code.length === 6
          ? "Code complete."
          : "Enter the 6-digit code we sent to your email."}
      </p>
    </div>
  );
}

export const Controlled: Story = {
  render: () => <VerificationDemo />,
};

export const Disabled: Story = {
  render: () => (
    <InputOTP maxLength={4} disabled>
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
        <InputOTPSlot index={3} />
      </InputOTPGroup>
    </InputOTP>
  ),
};

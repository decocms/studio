"use client";

import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { Minus } from "@untitledui/icons";

import { cn } from "../lib/utils.ts";

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        "flex items-center gap-(--space-xs) has-disabled:[&_[data-slot=input-otp-slot]]:bg-neutral-2 has-disabled:[&_[data-slot=input-otp-slot]]:text-neutral-6 has-disabled:[&_[data-slot=input-otp-slot]]:shadow-(--edge)",
        containerClassName,
      )}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn("flex items-center gap-(--space-xs)", className)}
      {...props}
    />
  );
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number;
}) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        "relative flex h-(--studio-control-height-xl) w-(--studio-control-height) items-center justify-center rounded-(--studio-control-radius) bg-neutral-1 text-s font-medium text-foreground shadow-[var(--edge),var(--shadow-s)] transition-[background-color,box-shadow,color] duration-(--motion-duration) ease-motion hover:shadow-[0_0_0_var(--border-s)_var(--neutral-5),var(--shadow-s)] aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error),var(--shadow-s)] data-[active=true]:z-10 data-[active=true]:shadow-[0_0_0_var(--border-s)_var(--color-1),var(--shadow-s)] data-[active=true]:aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error),var(--shadow-s)]",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="animate-caret-blink bg-foreground h-4 w-px duration-1000" />
        </div>
      )}
    </div>
  );
}

function InputOTPSeparator({ ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="input-otp-separator" role="separator" {...props}>
      <Minus />
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot };

import type * as React from "react";
import { OTPInput, REGEXP_ONLY_DIGITS, type SlotProps } from "input-otp";

import { cn } from "../lib/utils.ts";

type InputOtpProps = Omit<
  React.ComponentProps<typeof OTPInput>,
  "render" | "children" | "maxLength"
> & {
  /** Number of characters, one box each. */
  length: number;
  slotClassName?: string;
};

/**
 * One box per character over a single real input, so paste, SMS/email
 * autofill (`autoComplete="one-time-code"`) and screen readers see one field.
 * `onComplete` fires once every box is filled.
 */
function InputOtp({
  length,
  className,
  containerClassName,
  slotClassName,
  pattern = REGEXP_ONLY_DIGITS,
  inputMode = "numeric",
  autoComplete = "one-time-code",
  ...props
}: InputOtpProps) {
  return (
    <OTPInput
      data-slot="input-otp"
      maxLength={length}
      pattern={pattern}
      inputMode={inputMode}
      autoComplete={autoComplete}
      containerClassName={cn(
        "flex items-center gap-2 has-[:disabled]:opacity-50",
        containerClassName,
      )}
      className={cn("disabled:cursor-not-allowed", className)}
      render={({ slots }) => (
        <>
          {slots.map((slot, index) => (
            <InputOtpSlot
              // Slots are positional; the index is their identity.
              key={index}
              {...slot}
              invalid={props["aria-invalid"] === true}
              className={slotClassName}
            />
          ))}
        </>
      )}
      {...props}
    />
  );
}

function InputOtpSlot({
  char,
  placeholderChar,
  hasFakeCaret,
  isActive,
  invalid,
  className,
}: SlotProps & { invalid: boolean; className?: string }) {
  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive || undefined}
      className={cn(
        "relative flex h-12 w-10 flex-1 items-center justify-center text-xl font-medium tabular-nums text-foreground transition-[background-color,box-shadow]",
        "rounded-[var(--studio-control-radius,var(--radius-lg))] bg-[var(--studio-input-background)] shadow-edge",
        "data-active:shadow-[inset_0_0_0_2px_var(--ring)]",
        invalid &&
          "bg-destructive/10 shadow-[inset_0_0_0_1px_var(--destructive)]",
        className,
      )}
    >
      {char ?? (
        <span className="text-subtle-foreground">{placeholderChar}</span>
      )}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-px animate-pulse bg-foreground" />
        </div>
      )}
    </div>
  );
}

export { InputOtp };

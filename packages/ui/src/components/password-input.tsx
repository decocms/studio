import { useState } from "react";
import type * as React from "react";
import { Check, Copy01, Eye, EyeOff } from "@untitledui/icons";

import { IconButton } from "./icon-button.tsx";
import { InputGroup, InputGroupInput } from "./input.tsx";

function PasswordInput({
  className,
  value,
  showLabel = "Show",
  hideLabel = "Hide",
  copyLabel = "Copy",
  copiedLabel = "Copied",
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  /** Button names, translated by the caller. */
  showLabel?: string;
  hideLabel?: string;
  copyLabel?: string;
  copiedLabel?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (typeof value !== "string" || !value) return;
    // Denied on insecure origins or without permission; the label just stays.
    const ok = await navigator.clipboard.writeText(value).then(
      () => true,
      () => false,
    );
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <InputGroup className={className}>
      <InputGroupInput
        type={visible ? "text" : "password"}
        value={value}
        {...props}
      />
      <IconButton
        type="button"
        label={visible ? hideLabel : showLabel}
        onClick={() => setVisible(!visible)}
      >
        {visible ? <EyeOff /> : <Eye />}
      </IconButton>
      <IconButton
        type="button"
        label={copied ? copiedLabel : copyLabel}
        onClick={copy}
        disabled={!value}
      >
        {copied ? <Check /> : <Copy01 />}
      </IconButton>
    </InputGroup>
  );
}

export { PasswordInput };

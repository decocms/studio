/* oxlint-disable no-explicit-any */
import { useState } from "react";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { cn } from "../lib/utils.ts";
import { Eye, EyeOff, Check, Copy01 } from "@untitledui/icons";

interface PasswordInputProps {
  value?: string;
  onChange?: (e: any) => void;
  placeholder?: string;
  className?: string;
  [key: string]: any;
}

function PasswordInput({
  value,
  onChange,
  placeholder,
  className,
  ...props
}: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const handleCopy = async () => {
    if (value) {
      try {
        await navigator.clipboard.writeText(value);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } catch (err) {
        console.error("Failed to copy text: ", err);
      }
    }
  };

  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword);
  };

  return (
    <div className="relative">
      <Input
        type={showPassword ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={cn("pr-20", className)}
        {...props}
      />
      <div className="absolute inset-y-0 right-(--space-xxs) flex items-center gap-(--space-xxs)">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-(--studio-control-height-xs) p-0"
          onClick={togglePasswordVisibility}
          title={showPassword ? "Hide password" : "Show password"}
        >
          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-(--studio-control-height-xs) p-0"
          onClick={handleCopy}
          disabled={!value}
          title={copySuccess ? "Copied!" : "Copy token"}
        >
          {copySuccess ? <Check size={16} /> : <Copy01 size={16} />}
        </Button>
      </div>
    </div>
  );
}

export { PasswordInput };

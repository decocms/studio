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
      <div className="absolute right-1 top-1 flex items-center gap-1 h-8">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={togglePasswordVisibility}
          title={showPassword ? "Hide password" : "Show password"}
        >
          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
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

import { getAllCapybaraIcons } from "@/constants/capybara-icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Input } from "@deco/ui/components/input.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { Container, Edit05, Link01, XClose } from "@untitledui/icons";
import { useState, type ReactNode } from "react";

const SIZE_CLASSES = {
  sm: "h-8 w-8",
  md: "h-12 w-12",
  lg: "h-16 w-16",
};

type Size = keyof typeof SIZE_CLASSES;

interface IconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string | null) => void;
  name: string;
  size?: Size;
  className?: string;
  fallbackIcon?: ReactNode;
}

const capybaraIcons = getAllCapybaraIcons();

export function IconPicker({
  value,
  onChange,
  name,
  size = "lg",
  className,
  fallbackIcon,
}: IconPickerProps) {
  const [customUrl, setCustomUrl] = useState("");
  const [open, setOpen] = useState(false);

  const handleSelectIcon = (icon: string) => {
    onChange(icon);
    setOpen(false);
    setCustomUrl("");
  };

  const handleApplyCustomUrl = () => {
    const trimmed = customUrl.trim();
    if (trimmed) {
      onChange(trimmed);
      setOpen(false);
      setCustomUrl("");
    }
  };

  const handleClearIcon = () => {
    onChange(null);
    setOpen(false);
    setCustomUrl("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative group rounded-lg border border-border shrink-0 overflow-hidden cursor-pointer",
            SIZE_CLASSES[size],
            className,
          )}
        >
          <IconPreview
            key={value ?? "no-icon"}
            icon={value}
            name={name}
            fallbackIcon={fallbackIcon}
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
            <Edit05 size={16} className="text-white" />
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium">Choose icon</span>
            {value && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground"
                onClick={handleClearIcon}
              >
                <XClose size={12} />
                Remove
              </Button>
            )}
          </div>

          <ScrollArea className="h-48">
            <div className="grid grid-cols-7 gap-1 p-2">
              {capybaraIcons.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => handleSelectIcon(icon)}
                  className={cn(
                    "h-9 w-9 rounded-md overflow-hidden border transition-colors hover:border-primary cursor-pointer",
                    value === icon
                      ? "border-primary ring-1 ring-primary"
                      : "border-transparent",
                  )}
                >
                  <img
                    src={icon}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          </ScrollArea>

          <div className="flex items-center gap-1.5 p-2 border-t border-border">
            <Link01 size={14} className="text-muted-foreground shrink-0" />
            <Input
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="Paste image URL..."
              className="h-7 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleApplyCustomUrl();
                }
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs shrink-0"
              onClick={handleApplyCustomUrl}
              disabled={!customUrl.trim()}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function IconPreview({
  icon,
  name,
  fallbackIcon,
}: {
  icon: string | null | undefined;
  name: string;
  fallbackIcon?: ReactNode;
}) {
  const [errored, setErrored] = useState(false);

  if (!icon || errored) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-muted/20">
        {fallbackIcon ?? (
          <Container size={24} className="text-muted-foreground" />
        )}
      </div>
    );
  }

  return (
    <img
      src={icon}
      alt={name}
      className="h-full w-full object-cover"
      onError={() => setErrored(true)}
    />
  );
}

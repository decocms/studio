import { Check, Copy01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import { cn } from "@decocms/ui/lib/utils.ts";

/**
 * An icon button that copies `value`: the copy icon turns into a check while
 * the value is on the clipboard, and screen readers hear `copiedLabel`. The
 * value is only handed to the clipboard — never logged or stored.
 */
export function CopyValueButton({
  value,
  label,
  copiedLabel,
  variant = "ghost",
  size = "icon-sm",
  className,
  copiedClassName,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  variant?: "ghost" | "outline";
  size?: "icon-sm" | "icon";
  className?: string;
  /** Extra classes while the check shows. */
  copiedClassName?: string;
}) {
  const { handleCopy, copied } = useCopy();
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        aria-label={label}
        onClick={() => void handleCopy(value).catch(() => {})}
        className={cn(className, copied && copiedClassName)}
      >
        {copied ? <Check className="text-success" /> : <Copy01 />}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}

/**
 * A read-only value in a field, with a copy button inside its right end. The
 * button shows when an ancestor with the `group` class (the settings row) is
 * hovered or holds focus, on keyboard focus, while it shows its check, and
 * always on touch screens, which have no hover.
 */
export function CopyableField({
  id,
  value,
  copyLabel,
  copiedLabel,
  className,
}: {
  id: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
}) {
  return (
    <div className={cn("relative h-fit", className)}>
      <Input
        id={id}
        value={value}
        readOnly
        disabled
        className="pr-10 font-mono"
      />
      <CopyValueButton
        value={value}
        label={copyLabel}
        copiedLabel={copiedLabel}
        className={cn(
          "absolute top-1/2 right-1 -translate-y-1/2 transition-opacity",
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        )}
        copiedClassName="opacity-100"
      />
    </div>
  );
}

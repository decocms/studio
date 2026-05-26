import type { ComponentProps, Ref } from "react";
import { cn } from "@deco/ui/lib/utils.ts";

export interface ToolbarIconButtonProps extends ComponentProps<"button"> {
  active?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function ToolbarIconButton({
  active,
  className,
  ref,
  type = "button",
  ...props
}: ToolbarIconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "relative flex size-10 md:size-7 shrink-0 items-center justify-center rounded-md transition-colors",
        "max-md:[&_svg]:size-5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
        className,
      )}
      {...props}
    />
  );
}

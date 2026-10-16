import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

const orgAvatarVariants = cva(
  "bg-muted text-muted-foreground relative inline-flex shrink-0 items-center justify-center overflow-hidden font-medium",
  {
    variants: {
      size: {
        sm: "size-6 rounded-lg text-[0.625rem]",
        default: "size-8 rounded-[0.625rem] text-xs",
      },
      selected: {
        true: "outline-2 outline-offset-0 outline-foreground",
        false: "",
      },
    },
    defaultVariants: { size: "default", selected: false },
  },
);

type OrgAvatarProps = Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof orgAvatarVariants> & {
    /** The organization's logo. Without one, the first letter of `name`. */
    src?: string | null;
    name: string;
  };

/**
 * An organization's logo as a square tile, as the org rail shows it. The
 * selected org gets an ink ring outside the tile.
 */
function OrgAvatar({
  src,
  name,
  size,
  selected,
  className,
  ...props
}: OrgAvatarProps) {
  return (
    <span
      data-slot="org-avatar"
      className={cn(orgAvatarVariants({ size, selected }), className)}
      {...props}
    >
      {src ? (
        <img src={src} alt={name} className="size-full object-cover" />
      ) : (
        <span aria-label={name}>{name.trim().charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

export { OrgAvatar, orgAvatarVariants };
export type { OrgAvatarProps };

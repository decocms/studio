import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/**
 * The project's colour at 14% behind its icon, drawn in the full colour.
 * Small tiles are round (nav rows, chips); large ones are rounded squares
 * (rails, cards).
 */
const projectIconVariants = cva(
  "inline-flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:stroke-[1.5]",
  {
    variants: {
      color: {
        blue: "bg-project-blue/14 text-project-blue",
        green: "bg-project-green/14 text-project-green",
        purple: "bg-project-purple/14 text-project-purple",
        red: "bg-project-red/14 text-project-red",
        amber: "bg-project-amber/14 text-project-amber",
      },
      size: {
        sm: "size-5 rounded-full [&_svg]:size-3",
        default: "size-7 rounded-lg [&_svg]:size-4",
      },
    },
    defaultVariants: { color: "blue", size: "default" },
  },
);

type ProjectIconProps = Omit<React.ComponentProps<"span">, "color"> &
  VariantProps<typeof projectIconVariants>;

function ProjectIcon({ color, size, className, ...props }: ProjectIconProps) {
  return (
    <span
      data-slot="project-icon"
      className={cn(projectIconVariants({ color, size }), className)}
      {...props}
    />
  );
}

export { ProjectIcon, projectIconVariants };
export type { ProjectIconProps };

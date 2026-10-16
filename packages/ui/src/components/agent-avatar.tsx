import type * as React from "react";

import { cn } from "../lib/utils.ts";

type AgentAvatarProps = Omit<React.ComponentProps<"span">, "children"> & {
  /** The agent's face. The app owns the artwork and passes its URL. */
  src: string;
  /** Diameter in px. The face fills two thirds of it. */
  size?: number;
  alt?: string;
};

/**
 * The agent, wherever it acts: its face on a dark-green circle. Size it to the
 * row it sits in (20 in a small button, 26 in the header "Ask" button, 32 in
 * a chat header).
 */
function AgentAvatar({
  src,
  size = 24,
  alt = "",
  className,
  style,
  ...props
}: AgentAvatarProps) {
  return (
    <span
      data-slot="agent-avatar"
      className={cn(
        "bg-brand-green-dark inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
        className,
      )}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <img
        src={src}
        alt={alt}
        className="size-2/3 object-contain [image-rendering:pixelated]"
      />
    </span>
  );
}

export { AgentAvatar };
export type { AgentAvatarProps };

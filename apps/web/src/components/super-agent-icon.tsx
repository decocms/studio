import { cn } from "@deco/ui/lib/utils.ts";
import { SUPER_AGENT_ICON_URL } from "@/sdk";

/** The Super Agent (Decopilot) capybara glyph, rendered as a round avatar. */
export function SuperAgentIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={SUPER_AGENT_ICON_URL}
      alt="Super Agent"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={cn("shrink-0 rounded-full object-cover", className)}
    />
  );
}

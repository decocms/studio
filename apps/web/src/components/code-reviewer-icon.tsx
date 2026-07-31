import { cn } from "@deco/ui/lib/utils.ts";
import { CODE_REVIEWER_ICON_URL } from "@/sdk";

/** The Code Reviewer glyph, rendered as a round avatar so its review thread
 *  sits alongside the Super Agent and QA Agent on the task card. */
export function CodeReviewerIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={CODE_REVIEWER_ICON_URL}
      alt="Code Reviewer"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={cn("shrink-0 rounded-full object-cover", className)}
    />
  );
}

import { cn } from "@deco/ui/lib/utils.ts";
import { CODE_REVIEWER_COLOR, CODE_REVIEWER_ICON_URL } from "@/sdk";

/** The Code Reviewer glyph, rendered as a round avatar badge — a light tint
 *  of its own brand color with the glyph centered inside, matching the Super
 *  Agent capybara avatar's weight — so its review thread sits alongside the
 *  Super Agent and QA Agent on the task card. */
export function CodeReviewerIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        className,
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: `${CODE_REVIEWER_COLOR}26`,
      }}
    >
      <img
        src={CODE_REVIEWER_ICON_URL}
        alt="Code Reviewer"
        style={{ width: size * 0.6, height: size * 0.6 }}
      />
    </span>
  );
}

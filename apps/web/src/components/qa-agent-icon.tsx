import { cn } from "@decocms/ui/lib/utils.ts";
import { QA_AGENT_COLOR, QA_AGENT_ICON_URL } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";

/** The QA Agent glyph, rendered as a round avatar badge — a light tint of its
 *  own brand color with the glyph centered inside — so it reads with the same
 *  visual weight as the Super Agent capybara avatar instead of a bare line
 *  icon, and sits alongside the Super Agent and member avatars in the
 *  assignee picker. */
export function QaAgentIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        className,
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: `${QA_AGENT_COLOR}26`,
      }}
    >
      <img
        src={QA_AGENT_ICON_URL}
        alt={t("taskBoard.taskDialog.qaAgentLabel")}
        style={{ width: size * 0.6, height: size * 0.6 }}
      />
    </span>
  );
}

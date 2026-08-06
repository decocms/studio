import { cn } from "@deco/ui/lib/utils.ts";
import { QA_AGENT_ICON_URL } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";

/** The QA Agent glyph, rendered as a round avatar so it sits alongside the
 *  Super Agent and member avatars in the assignee picker. */
export function QaAgentIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const t = useT();
  return (
    <img
      src={QA_AGENT_ICON_URL}
      alt={t("taskBoard.taskDialog.qaAgentLabel")}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={cn("shrink-0 rounded-full object-cover", className)}
    />
  );
}

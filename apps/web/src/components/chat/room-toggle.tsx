import { Users01, User01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { toast } from "sonner";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useOptionalChatTask } from "./context";
import { useThreadActions } from "./store/hooks";

/**
 * Open the current thread as a shared room, or close it back to a personal
 * chat. A shared room accepts messages from every member of the organization;
 * a personal chat only from the person who opened it (enforced server-side —
 * see `canWriteToThread`).
 *
 * Only the owner sees the control: a teammate can already read the thread, but
 * who may write to it is the owner's call.
 */
export function RoomToggle() {
  const t = useT();
  const task = useOptionalChatTask()?.activeTask ?? null;
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const { setShared } = useThreadActions();

  if (!task || !userId) return null;
  // `created_by` is absent on an optimistic row that hasn't landed yet — no
  // owner to compare against, so hold the control back until it does.
  if (!task.created_by || task.created_by !== userId) return null;

  const shared = task.metadata?.shared === true;
  const label = shared
    ? t("chat.roomToggle.sharedRoom")
    : t("chat.roomToggle.personalChat");

  async function toggle() {
    const next = !shared;
    track("chat_room_shared_toggled", { thread_id: task!.id, shared: next });
    try {
      await setShared(task!.id, next);
      toast.success(
        next
          ? t("chat.roomToggle.nowShared")
          : t("chat.roomToggle.nowPersonal"),
      );
    } catch {
      // optimisticUpdate rolls the row back; say so rather than leaving the
      // icon lying about the thread's state.
      toast.error(t("chat.roomToggle.failed"));
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          aria-pressed={shared}
          active={shared}
          onClick={() => void toggle()}
        >
          {shared ? <Users01 size={16} /> : <User01 size={16} />}
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {shared
          ? t("chat.roomToggle.tooltipShared")
          : t("chat.roomToggle.tooltipPersonal")}
      </TooltipContent>
    </Tooltip>
  );
}

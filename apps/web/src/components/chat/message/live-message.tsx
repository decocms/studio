import { useT } from "@/i18n/use-t.ts";
import { liveMessagePartId, useLiveMessages } from "../live-messages.ts";
import type { ChatMessage } from "../types.ts";
import { MessageUser } from "./user.tsx";

/**
 * A message the user sent while the run was working, shown inside the run's
 * answer: where the model read it, or under the answer until it does.
 */
export function LiveMessage({
  message,
  pending,
}: {
  message: ChatMessage;
  pending: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1 py-1">
      <span className="self-end px-3 text-xs text-muted-foreground">
        {pending
          ? t("chat.liveMessage.pending")
          : t("chat.liveMessage.readByAgent")}
      </span>
      <MessageUser message={message} />
    </div>
  );
}

/** The `data-live-message` part: the message the model read at this point. */
export function LiveMessagePart({ part }: { part: unknown }) {
  const { read } = useLiveMessages();
  const id = liveMessagePartId(part);
  const message = id ? read.get(id) : undefined;
  // Not loaded (an older page) or not ours to show: nothing at this point.
  if (!message) return null;
  return <LiveMessage message={message} pending={false} />;
}

// New task — the centered composer modal (Figma 8288). It REUSES the real
// Chat.Input, so submitting creates a real thread and navigates to the chat,
// exactly like the existing home composer. Wiring the new task into the normal
// tasks/chat system for free.
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Chat } from "@/web/components/chat";

export function NewTaskDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="border-none bg-transparent p-0 shadow-none sm:max-w-[572px]"
        closeButtonClassName="hidden"
      >
        <DialogTitle className="sr-only">New task</DialogTitle>
        {/* Real composer (no connections footer): creates a thread +
            navigates to /$org/$taskId on send. */}
        <Chat.Input />
      </DialogContent>
    </Dialog>
  );
}

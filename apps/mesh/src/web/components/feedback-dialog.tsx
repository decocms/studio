import { useState } from "react";
import { MessageChatCircle } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { toast } from "@deco/ui/components/sonner.js";
import { track, getSessionReplayUrl } from "@/web/lib/posthog-client";

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
}

export function FeedbackDialog({
  open,
  onOpenChange,
  orgSlug,
}: FeedbackDialogProps) {
  const [message, setMessage] = useState("");

  const handleSubmit = () => {
    if (!message.trim()) return;
    fetch(`/api/${orgSlug}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message.trim() }),
    });
    track("user_feedback_submitted", {
      session_replay_url: getSessionReplayUrl(),
    });
    setMessage("");
    onOpenChange(false);
    toast.success("Feedback sent — thank you!");
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) setMessage("");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md gap-5">
        <DialogHeader className="gap-1">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <MessageChatCircle size={18} className="text-muted-foreground" />
            Feedback
          </DialogTitle>
          <DialogDescription>
            Tell us what's on your mind — bugs, ideas, or anything else.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground">Message</label>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Tell us about your experience, bugs you've found, or features you'd like to see..."
            className="min-h-32 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleSubmit();
              }
            }}
          />
        </div>

        <div className="flex items-center justify-between pt-1">
          <a
            href="mailto:contact@decocms.com"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            contact@decocms.com
          </a>
          <Button onClick={handleSubmit} disabled={!message.trim()} size="sm">
            Send feedback
            <span className="ml-1.5 text-xs opacity-60">⌘↵</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

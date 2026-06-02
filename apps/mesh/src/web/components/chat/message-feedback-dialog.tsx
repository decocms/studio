import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { toast } from "@deco/ui/components/sonner.js";
import { track, getSessionReplayUrl } from "@/web/lib/posthog-client";
import { submitFeedback } from "@/web/lib/submit-feedback";

const REASONS = [
  "Incorrect or incomplete",
  "Not what I asked for",
  "Slow or buggy",
  "Style or tone",
  "Safety or legal concern",
  "Other",
] as const;

type Reason = (typeof REASONS)[number];

interface MessageFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  messageId: string;
  threadId: string | null;
}

export function MessageFeedbackDialog({
  open,
  onOpenChange,
  orgSlug,
  messageId,
  threadId,
}: MessageFeedbackDialogProps) {
  const [selected, setSelected] = useState<Set<Reason>>(new Set());
  const [details, setDetails] = useState("");
  const [sending, setSending] = useState(false);

  const canSubmit = selected.size > 0 || !!details.trim();

  const toggle = (reason: Reason) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(reason)) {
        next.delete(reason);
      } else {
        next.add(reason);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (sending || !canSubmit || !orgSlug) return;
    setSending(true);
    try {
      const res = await submitFeedback(orgSlug, {
        kind: "chat_negative",
        messageId,
        threadId,
        reasons: selected.size > 0 ? [...selected] : undefined,
        details: details.trim() || undefined,
      });
      if (!res.ok) {
        toast.error("Failed to send feedback. Please try again.");
        return;
      }
      track("chat_message_feedback_negative", {
        message_id: messageId,
        thread_id: threadId,
        reasons: selected.size > 0 ? [...selected] : undefined,
        session_replay_url: getSessionReplayUrl(),
      });
      setSelected(new Set());
      setDetails("");
      onOpenChange(false);
      toast.success("Feedback sent — thank you!");
    } catch {
      toast.error("Failed to send feedback. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setDetails("");
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg gap-5">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            Share feedback
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              onClick={() => toggle(reason)}
              className={cn(
                "px-3 py-1.5 rounded-full border text-sm transition-colors",
                selected.has(reason)
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-foreground hover:border-foreground/50",
              )}
            >
              {reason}
            </button>
          ))}
        </div>

        <Textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="Share details (optional)"
          className="min-h-28 resize-none"
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.metaKey || e.ctrlKey) &&
              canSubmit &&
              !sending
            ) {
              void handleSubmit();
            }
          }}
        />

        <div className="flex justify-end">
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || sending || !orgSlug}
            size="sm"
          >
            Submit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

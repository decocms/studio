import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type ConfirmationArgs = {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export default function Confirmation() {
  const { args } = useWidget<ConfirmationArgs>();
  const [resolved, setResolved] = useState<"confirmed" | "cancelled" | null>(
    null,
  );

  if (!args) return null;

  const {
    title = "Are you sure?",
    message = "This action cannot be undone.",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
  } = args;

  if (resolved) {
    return (
      <div className="p-4 font-sans text-center">
        <div
          className={cn(
            "text-sm font-medium",
            resolved === "confirmed"
              ? "text-green-600"
              : "text-muted-foreground",
          )}
        >
          {resolved === "confirmed" ? "✓ Confirmed" : "✕ Cancelled"}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 font-sans">
      <div className="text-sm font-semibold text-foreground mb-1">{title}</div>
      <div className="text-sm text-muted-foreground mb-4">{message}</div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setResolved("confirmed")}
          className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setResolved("cancelled")}
          className="px-4 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm font-medium hover:bg-accent transition-colors"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

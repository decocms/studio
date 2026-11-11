/**
 * "Send feedback" and "Report a problem" in the Help menu: a message plus
 * screenshots, sent as multipart to `POST /api/:org/feedback` (`kind`,
 * `message`, `pageUrl`, `screenshot`×n).
 */

import { useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { Camera01, XClose } from "@untitledui/icons";
import {
  type FeedbackKind,
  FEEDBACK_MAX_MESSAGE_CHARS,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_MAX_SCREENSHOTS,
  FEEDBACK_SCREENSHOT_TYPES,
} from "@decocms/shared/feedback";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useT } from "@/i18n/use-t";
import { useProjectContext } from "@/sdk";

/** Long enough for the dialog's exit animation to leave the frame. */
const DIALOG_EXIT_MS = 250;

interface Screenshot {
  file: File;
  previewUrl: string;
}

function canCaptureScreen(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getDisplayMedia
  );
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * One frame of the tab (or screen) the user picks. The browser asks which
 * surface to share every time; Chrome offers this tab first.
 */
async function captureScreenFrame(): Promise<File> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    // Chromium-only hints, not yet in the DOM typings.
    ...({ preferCurrentTab: true, selfBrowserSurface: "include" } as object),
  });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // The share prompt and the dialog's exit can still be in the first frames.
    await new Promise((resolve) => setTimeout(resolve, DIALOG_EXIT_MS));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    video.srcObject = null;

    let blob = await canvasToBlob(canvas, "image/png");
    if (!blob || blob.size > FEEDBACK_MAX_SCREENSHOT_BYTES) {
      blob = await canvasToBlob(canvas, "image/jpeg", 0.85);
    }
    if (!blob) throw new Error("Could not encode the screenshot");
    const ext = blob.type === "image/png" ? "png" : "jpg";
    return new File([blob], `screenshot.${ext}`, { type: blob.type });
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

export function FeedbackDialog({
  kind,
  open,
  onOpenChange,
}: {
  kind: FeedbackKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const copy =
    kind === "problem"
      ? {
          title: t("sidebar.problem.title"),
          placeholder: t("sidebar.problem.placeholder"),
          sent: t("sidebar.problem.sent"),
          failed: t("sidebar.problem.failed"),
        }
      : {
          title: t("sidebar.feedback.title"),
          placeholder: t("sidebar.feedback.placeholder"),
          sent: t("sidebar.feedback.sent"),
          failed: t("sidebar.feedback.failed"),
        };
  const { org } = useProjectContext();
  const [message, setMessage] = useState("");
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [capturing, setCapturing] = useState(false);

  const reset = () => {
    for (const shot of screenshots) URL.revokeObjectURL(shot.previewUrl);
    setScreenshots([]);
    setMessage("");
  };

  const addScreenshots = (files: File[]) => {
    const accepted = files.filter((file) => {
      if (!FEEDBACK_SCREENSHOT_TYPES.includes(file.type)) return false;
      if (file.size > FEEDBACK_MAX_SCREENSHOT_BYTES) {
        toast.error(t("sidebar.feedback.screenshotTooLarge"));
        return false;
      }
      return true;
    });
    const room = FEEDBACK_MAX_SCREENSHOTS - screenshots.length;
    if (accepted.length > room) {
      toast.error(
        t("sidebar.feedback.tooManyScreenshots", {
          max: String(FEEDBACK_MAX_SCREENSHOTS),
        }),
      );
    }
    const added = accepted.slice(0, Math.max(room, 0)).map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    if (added.length > 0) setScreenshots((prev) => [...prev, ...added]);
  };

  const removeScreenshot = (shot: Screenshot) => {
    URL.revokeObjectURL(shot.previewUrl);
    setScreenshots((prev) => prev.filter((s) => s !== shot));
  };

  const takeScreenshot = async () => {
    // Hide the dialog so the shot shows the page, not the form.
    setCapturing(true);
    try {
      // Asked straight away: Safari drops the click's user activation across a wait.
      addScreenshots([await captureScreenFrame()]);
    } catch (err) {
      // Dismissing the share prompt is a choice, not a failure.
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        console.error("[feedback] screenshot failed", err);
        toast.error(t("sidebar.feedback.screenshotFailed"));
      }
    } finally {
      setCapturing(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    event.preventDefault();
    addScreenshots(images);
  };

  const send = useMutation({
    mutationFn: async () => {
      const body = new FormData();
      body.set("kind", kind);
      body.set("message", message.trim());
      body.set("pageUrl", window.location.href);
      for (const shot of screenshots) body.append("screenshot", shot.file);
      const res = await fetch(`/api/${encodeURIComponent(org.slug)}/feedback`, {
        method: "POST",
        body,
      });
      if (!res.ok) throw new Error(`Feedback failed: ${res.status}`);
    },
    onSuccess: () => {
      toast.success(copy.sent);
      reset();
      onOpenChange(false);
    },
    onError: () => toast.error(copy.failed),
  });

  const canSend = message.trim().length > 0 && !send.isPending;

  return (
    <Dialog open={open && !capturing} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>
        <Textarea
          autoFocus
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (canSend) send.mutate();
            }
          }}
          placeholder={copy.placeholder}
          className="min-h-32 max-h-80"
          maxLength={FEEDBACK_MAX_MESSAGE_CHARS}
        />
        {screenshots.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {screenshots.map((shot, index) => (
              <div
                key={shot.previewUrl}
                className="group relative size-20 overflow-hidden rounded-lg shadow-edge"
              >
                <a href={shot.previewUrl} target="_blank" rel="noreferrer">
                  <img
                    src={shot.previewUrl}
                    alt={t("sidebar.feedback.screenshotAlt", {
                      n: String(index + 1),
                    })}
                    className="size-full object-cover"
                  />
                </a>
                <button
                  type="button"
                  onClick={() => removeScreenshot(shot)}
                  aria-label={t("sidebar.feedback.removeScreenshot")}
                  className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-edge transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <XClose size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          {canCaptureScreen() ? (
            <Button
              type="button"
              variant="outline"
              onClick={takeScreenshot}
              disabled={screenshots.length >= FEEDBACK_MAX_SCREENSHOTS}
            >
              <Camera01 size={14} />
              {t("sidebar.feedback.takeScreenshot")}
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            onClick={() => send.mutate()}
            disabled={!canSend}
          >
            {send.isPending
              ? t("sidebar.feedback.sending")
              : t("sidebar.feedback.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

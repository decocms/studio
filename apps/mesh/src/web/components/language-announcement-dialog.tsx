import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { authClient } from "@/web/lib/auth-client";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { useT } from "@/web/i18n/use-t.ts";
import { track } from "@/web/lib/posthog-client";

// When pt-BR shipped. Only users created before this see the announcement;
// anyone who signs up afterwards already gets the language picker from day one
// (and the browser-based default via detectLocale), so there's nothing new to
// announce to them.
const PT_BR_RELEASE = Date.parse("2026-07-21T00:00:00Z");

function markSeen(userId: string) {
  try {
    localStorage.setItem(LOCALSTORAGE_KEYS.ptBrAnnouncementSeen(userId), "1");
  } catch {}
}

function hasSeen(userId: string) {
  try {
    return (
      localStorage.getItem(LOCALSTORAGE_KEYS.ptBrAnnouncementSeen(userId)) ===
      "1"
    );
  } catch {
    return false;
  }
}

/**
 * One-time modal announcing that Portuguese (Brazil) is now available. Shown
 * once per user, only to existing English-speaking users (created before the
 * pt-BR release). Dismissing it — via either button, the close icon, or the
 * overlay — persists the "seen" flag so it never returns.
 */
export function LanguageAnnouncementDialog() {
  const t = useT();
  const [preferences, setPreferences] = usePreferences();
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;
  const userId = user?.id;

  const createdAt = (user as { createdAt?: string | Date } | undefined)
    ?.createdAt;
  const isExistingUser =
    createdAt != null && new Date(createdAt).getTime() < PT_BR_RELEASE;

  const eligible =
    !isPending &&
    !!userId &&
    isExistingUser &&
    preferences.language === "en" &&
    !hasSeen(userId);

  // Decide once, on the first render where the session has settled — mirrors
  // the derived-state pattern used by VersionCheckDialog (no useEffect).
  const [decided, setDecided] = useState(false);
  const [open, setOpen] = useState(false);
  if (!decided && !isPending) {
    setDecided(true);
    if (eligible) {
      setOpen(true);
      track("pt_br_announcement_shown");
    }
  }

  const dismiss = (action: "switch" | "keep" | "close") => {
    if (userId) markSeen(userId);
    track("pt_br_announcement_dismissed", { action });
    setOpen(false);
  };

  const switchToPortuguese = () => {
    setPreferences((prev) => ({ ...prev, language: "pt-BR" }));
    dismiss("switch");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss("close")}>
      <DialogContent className="sm:max-w-md">
        <div className="text-4xl" aria-hidden="true">
          🇧🇷
        </div>
        <DialogHeader>
          <DialogTitle>{t("announcements.ptBr.title")}</DialogTitle>
          <DialogDescription>
            {t("announcements.ptBr.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => dismiss("keep")}>
            {t("announcements.ptBr.keep")}
          </Button>
          <Button onClick={switchToPortuguese}>
            {t("announcements.ptBr.switch")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

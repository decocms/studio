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
import { authClient } from "@/lib/auth-client";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { detectLocale } from "@/i18n/locale.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { makeSeenFlag } from "@/lib/seen-flag";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";

// When pt-BR shipped. Only users created before this are auto-switched; anyone
// who signs up afterwards already gets pt-BR as their default (via detectLocale)
// when their browser is Portuguese, so there's nothing to announce to them.
const PT_BR_RELEASE = Date.parse("2026-07-21T00:00:00Z");

const ptBrSeen = (userId: string) =>
  makeSeenFlag(LOCALSTORAGE_KEYS.ptBrAnnouncementSeen(userId));

/**
 * One-time heads-up shown when we auto-switch an existing user to Portuguese.
 *
 * Existing users (created before the pt-BR release) whose browser is set to
 * Portuguese are flipped to pt-BR automatically, then this modal — now rendered
 * in Portuguese — tells them so and offers a one-click revert to English. The
 * "seen" flag persists per user, so it fires once and, crucially, we never
 * re-flip someone who chose to switch back on their next reload.
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

  const browserIsPortuguese = detectLocale() === "pt-BR";

  const eligible =
    !isPending &&
    !!userId &&
    isExistingUser &&
    browserIsPortuguese &&
    preferences.language === "en" &&
    !ptBrSeen(userId).has();

  // Decide once, on the first render where the session has settled — mirrors
  // the derived-state pattern used by VersionCheckDialog (no useEffect). On the
  // eligible path we auto-switch to pt-BR here, then open the heads-up.
  const [decided, setDecided] = useState(false);
  const [open, setOpen] = useState(false);
  if (!decided && !isPending) {
    setDecided(true);
    if (eligible && userId) {
      ptBrSeen(userId).mark();
      setPreferences((prev) => ({ ...prev, language: "pt-BR" }));
      setOpen(true);
      track("pt_br_auto_switch_shown");
    }
  }

  const close = (action: "ok" | "switch-back" | "dismiss") => {
    track("pt_br_auto_switch_closed", { action });
    setOpen(false);
  };

  const switchBackToEnglish = () => {
    setPreferences((prev) => ({ ...prev, language: "en" }));
    close("switch-back");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close("dismiss")}>
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
          <Button variant="outline" onClick={switchBackToEnglish}>
            {t("announcements.ptBr.switchBack")}
          </Button>
          <Button onClick={() => close("ok")}>
            {t("announcements.ptBr.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { type ComponentType, type ReactNode, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@decocms/ui/components/drawer.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Check } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import {
  clearLegacyAdminArrival,
  hasLegacyAdminArrival,
} from "@/lib/legacy-admin-arrival";
import { track } from "@/lib/posthog-client";

const SUPPORT_EMAIL = "support@deco.cx";

const BENEFITS = [
  "announcements.legacyAdmin.benefitPreview",
  "announcements.legacyAdmin.benefitCompare",
  "announcements.legacyAdmin.benefitAgent",
] as const;

type CloseAction = "continue" | "dismiss" | "support";

type TextSlot = ComponentType<{ className?: string; children?: ReactNode }>;

/**
 * Welcomes someone the legacy admin redirected here. Mounted on the login
 * screen and in the shell, so it shows whether or not they are signed in;
 * dismissing it in either place clears the arrival for the session. A centered
 * modal on desktop, a bottom sheet on phones.
 */
export function LegacyAdminWelcomeDialog() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(() => hasLegacyAdminArrival());

  const close = (action: CloseAction) => {
    clearLegacyAdminArrival();
    track("legacy_admin_welcome_closed", { action });
    setOpen(false);
  };

  const onOpenChange = (next: boolean) => {
    if (!next) close("dismiss");
  };

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="overflow-hidden data-[vaul-drawer-direction=bottom]:rounded-t-2xl">
          <WelcomeBody
            Title={DrawerTitle}
            Description={DrawerDescription}
            onClose={close}
          />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-[30rem]"
        closeButtonClassName="bg-background/70 text-foreground hover:bg-background"
      >
        <WelcomeBody
          Title={DialogTitle}
          Description={DialogDescription}
          onClose={close}
        />
      </DialogContent>
    </Dialog>
  );
}

function WelcomeBody({
  Title,
  Description,
  onClose,
}: {
  Title: TextSlot;
  Description: TextSlot;
  onClose: (action: CloseAction) => void;
}) {
  const t = useT();

  return (
    <>
      <div className="relative mt-4 h-56 shrink-0 overflow-hidden bg-brand md:mt-0 md:h-64">
        <img
          src="/legacy-admin-welcome.webp"
          alt=""
          aria-hidden="true"
          className="absolute top-8 left-8 w-[24rem] max-w-none rounded-tl-xl shadow-xl md:top-10 md:left-10 md:w-[34rem]"
        />
      </div>
      <div className="flex flex-col p-6 md:p-7">
        <Title className="text-left text-xl font-semibold">
          {t("announcements.legacyAdmin.title")}
        </Title>
        <Description className="mt-2 text-left text-sm">
          {t("announcements.legacyAdmin.description")}
        </Description>
        <ul className="mt-5 flex flex-col gap-3.5">
          {BENEFITS.map((key) => (
            <li key={key} className="flex items-start gap-3 text-sm">
              <Check
                size={16}
                strokeWidth={2.5}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-brand-green-dark dark:text-brand"
              />
              {t(key)}
            </li>
          ))}
        </ul>
        <Button
          size="lg"
          className="mt-6 w-full"
          onClick={() => onClose("continue")}
        >
          {t("announcements.legacyAdmin.continue")}
        </Button>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t("announcements.legacyAdmin.questions")}{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            onClick={() => onClose("support")}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {SUPPORT_EMAIL}
          </a>
        </p>
      </div>
    </>
  );
}

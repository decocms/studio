/**
 * Site Editor Onboarding Modal
 *
 * Shown when the user clicks the Site Editor agent on the home page.
 * Presents three paths: Import from deco.cx (active), GitHub (coming soon),
 * and Start from scratch (coming soon).
 *
 * Renders as a bottom Drawer on mobile and a centered Dialog on desktop.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";

interface OnboardingCard {
  id: string;
  title: string;
  buttonLabel: string;
  comingSoon: boolean;
  image?: string;
}

const CARDS: OnboardingCard[] = [
  {
    id: "deco",
    title: "Import from deco.cx",
    buttonLabel: "Import site",
    comingSoon: false,
    image: "/import-decocx.png",
  },
  {
    id: "github",
    title: "Existing GitHub project",
    buttonLabel: "Coming Soon",
    comingSoon: true,
    image: "/import-github.png",
  },
  {
    id: "scratch",
    title: "Start from scratch",
    buttonLabel: "Coming Soon",
    comingSoon: true,
    image: "/import-scratch.png",
  },
];

interface OnboardingContentProps {
  onCardAction: (cardId: string) => void;
  mobile?: boolean;
}

function OnboardingContent({ onCardAction, mobile }: OnboardingContentProps) {
  return (
    <div
      className={cn(
        "sm:grid sm:grid-cols-3 sm:gap-4",
        mobile ? "flex flex-col flex-1 min-h-0 gap-3" : "flex flex-col gap-3",
      )}
    >
      {CARDS.map((card) => (
        <button
          key={card.id}
          type="button"
          disabled={card.comingSoon}
          onClick={() => onCardAction(card.id)}
          className={cn(
            "rounded-xl border border-border bg-card overflow-hidden text-left",
            "transition-transform duration-150 ease-out will-change-transform",
            "flex flex-row items-center sm:flex-col",
            mobile && "flex-1 min-h-0",
            !card.comingSoon &&
              "[@media(hover:hover)]:hover:scale-[1.03] sm:[@media(hover:hover)]:hover:scale-[1.05] active:scale-[0.98] cursor-pointer",
            card.comingSoon && "cursor-default",
          )}
        >
          {/* Image — fixed 4/3 ratio; constrained width on mobile, full width on desktop */}
          <div
            className={cn(
              "w-28 shrink-0 self-stretch sm:w-full sm:aspect-[4/3] sm:self-auto bg-muted overflow-hidden",
              card.comingSoon && "opacity-40",
            )}
          >
            {card.image && (
              <img
                src={card.image}
                alt={card.title}
                className="w-full h-full object-cover"
              />
            )}
          </div>

          {/* Title + Button */}
          <div className="flex flex-1 flex-row items-center justify-between gap-3 px-4 py-3 sm:flex-col sm:items-stretch sm:px-5 sm:py-4 sm:gap-0">
            <p className="font-medium text-foreground text-sm sm:text-base sm:text-center sm:mb-4">
              {card.title}
            </p>
            <Button
              className="shrink-0 cursor-pointer sm:w-full"
              size="sm"
              variant={card.comingSoon ? "outline" : "default"}
              disabled={card.comingSoon}
              onClick={(e) => {
                e.stopPropagation();
                onCardAction(card.id);
              }}
            >
              {card.buttonLabel}
            </Button>
          </div>
        </button>
      ))}
    </div>
  );
}

const HEADER_ICON = (
  <IntegrationIcon
    icon="icon://Globe01?color=violet"
    name="Site Editor"
    size="sm"
  />
);

interface SiteEditorOnboardingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SiteEditorOnboardingModal({
  open,
  onOpenChange,
}: SiteEditorOnboardingModalProps) {
  const [importOpen, setImportOpen] = useState(false);
  const isMobile = useIsMobile();

  const handleCardAction = (cardId: string) => {
    if (cardId === "deco") {
      onOpenChange(false);
      setImportOpen(true);
    }
  };

  return (
    <>
      {isMobile ? (
        <Drawer open={open} onOpenChange={onOpenChange}>
          <DrawerContent className="h-[70dvh]">
            <DrawerHeader className="px-4 pt-4 pb-4 shrink-0">
              <div className="flex items-center gap-3">
                {HEADER_ICON}
                <DrawerTitle className="text-xl font-semibold">
                  Get started with Site Editor
                </DrawerTitle>
              </div>
            </DrawerHeader>
            <div className="flex flex-col flex-1 min-h-0 px-4 pb-8">
              <OnboardingContent onCardAction={handleCardAction} mobile />
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-[900px] p-8">
            <DialogHeader className="mb-8">
              <div className="flex items-center gap-3">
                {HEADER_ICON}
                <DialogTitle className="text-xl font-semibold">
                  Get started with Site Editor
                </DialogTitle>
              </div>
            </DialogHeader>
            <OnboardingContent onCardAction={handleCardAction} />
          </DialogContent>
        </Dialog>
      )}

      <ImportFromDecoDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onBack={() => {
          setImportOpen(false);
          onOpenChange(true);
        }}
      />
    </>
  );
}

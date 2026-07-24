import { useT } from "@/i18n/use-t.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { ChevronRight, X } from "@untitledui/icons";
import type { ReactNode } from "react";
import { ConnectQuotePanel, ConnectTrustSignals } from "./connect-extras.tsx";

/**
 * Shared chrome for the commerce connect step, used by BOTH the live
 * {@link CommerceConnectModal} and the dev preview harness so they can't drift.
 * Matches Figma node 9473-8422: a clean left column (breadcrumb header →
 * heading + source rows → pinned footer CTA) and a full-bleed brand-photo quote
 * panel on the right (desktop only). A close control sits top-right.
 */
export function ConnectLayout({
  siteHost,
  footer,
  onClose,
  children,
}: {
  siteHost?: string | null;
  /** Pinned footer (the primary CTA + any error). */
  footer: ReactNode;
  /** Optional close control (top-right). Omit to render a non-dismissable modal. */
  onClose?: () => void;
  /** Heading + source rows (own their internal scroll). */
  children: ReactNode;
}) {
  const t = useT();
  const faviconUrl = siteHost
    ? `https://www.google.com/s2/favicons?domain=${siteHost}&sz=128`
    : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("routes.commerceOnboarding.connectModal.close")}
          className="absolute right-3 top-3 z-10 flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-black/10 hover:text-foreground lg:text-white/80 lg:hover:bg-white/15 lg:hover:text-white"
        >
          <X size={18} />
        </button>
      )}

      {/* Left column */}
      <div className="flex min-h-0 flex-1 flex-col gap-8 bg-background p-6 lg:p-8">
        {/* Breadcrumb header: deco → site */}
        <div className="flex items-center gap-2">
          <img
            src="/logos/deco logo.svg"
            alt="Deco"
            className="size-7 shrink-0 dark:hidden"
          />
          <img
            src="/logos/deco logo negative.svg"
            alt="Deco"
            className="hidden size-7 shrink-0 dark:block"
          />
          {siteHost && (
            <>
              <ChevronRight size={16} className="shrink-0 text-foreground/25" />
              {faviconUrl && (
                <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded bg-white">
                  <img src={faviconUrl} alt="" className="size-full" />
                </span>
              )}
              <span className="truncate text-[15px] leading-tight text-muted-foreground">
                {siteHost}
              </span>
            </>
          )}
        </div>

        {children}

        <div className="flex shrink-0 flex-col gap-3">{footer}</div>
      </div>

      {/* Right: full-bleed brand-photo quote panel (desktop only). */}
      <aside className="relative hidden shrink-0 overflow-hidden lg:flex lg:w-[440px] lg:flex-col lg:p-14">
        <img
          src="https://decoims.com/image?src=decocms%2F8191643a-1947-4c30-afb4-36b8073c90fb%2Fbg-quote.png&quality=original&fit=cover&width=880"
          alt=""
          className="absolute inset-0 size-full object-cover"
        />
        {/* Scrim keeps the white quote legible over the brighter parts. */}
        <div className="absolute inset-0 bg-black/20" />
        {/* Quote centers in the space above the trust signals, which pin to the
            bottom (equal flex spacers above/below the quote). */}
        <div className="relative z-10 flex h-full flex-col">
          <div className="flex-1" />
          <ConnectQuotePanel />
          <div className="flex-1" />
          <ConnectTrustSignals />
        </div>
      </aside>
    </div>
  );
}

/** Shared footer CTA — solid primary, muted while the required source is
 *  missing. Used by the modal and preview so the button reads identically. */
export function ConnectFooterButton({
  ready,
  pending,
  label,
  onClick,
  children,
}: {
  ready: boolean;
  pending?: boolean;
  label: string;
  onClick?: () => void;
  /** Optional trailing content (e.g. an arrow) when ready. */
  children?: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="lg"
      className="h-auto min-h-12 w-full whitespace-normal rounded-lg py-3 text-center text-base font-medium leading-tight"
      onClick={onClick}
      disabled={pending || !ready}
    >
      {label}
      {ready && !pending ? children : null}
    </Button>
  );
}

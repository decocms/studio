/**
 * Floating toolbar for demoing credit UI states.
 *
 * Provides DecoCreditsOverrideContext so all credit-aware components
 * render the selected demo state instead of real data.
 */

import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  DecoCreditsOverrideContext,
  type DecoCreditsData,
} from "@/web/hooks/use-deco-credits";

const noop = () => {};

function makeState(partial: Partial<DecoCreditsData>): DecoCreditsData {
  return {
    hasDecoKey: true,
    decoKeyId: "demo-key",
    balanceCents: null,
    balanceDollars: null,
    hasCredits: false,
    isZeroBalance: false,
    isInitialFreeCredit: false,
    hasOnlyDecoProvider: true,
    isLoading: false,
    isFetching: false,
    refetch: noop,
    isDemoOverride: true,
    ...partial,
  };
}

const STATES: [string, string, DecoCreditsData | null][] = [
  ["off", "Live", null],
  [
    "free-$2",
    "Free $2",
    makeState({
      balanceCents: 200,
      balanceDollars: 2,
      hasCredits: true,
      isInitialFreeCredit: true,
    }),
  ],
  [
    "$0-balance",
    "$0 Balance",
    makeState({
      balanceCents: 0,
      balanceDollars: 0,
      isZeroBalance: true,
    }),
  ],
  [
    "$50-balance",
    "$50 Balance",
    makeState({
      balanceCents: 5000,
      balanceDollars: 50,
      hasCredits: true,
      hasOnlyDecoProvider: false,
    }),
  ],
  [
    "no-key",
    "No Key",
    makeState({
      hasDecoKey: false,
      decoKeyId: null,
      hasOnlyDecoProvider: false,
    }),
  ],
];

export function CreditsDemoToolbar({
  children,
}: {
  children: React.ReactNode;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const override = STATES[activeIdx][2];

  return (
    <>
      <DecoCreditsOverrideContext value={override}>
        {children}
      </DecoCreditsOverrideContext>
      <div className="fixed bottom-4 right-4 z-[9999] flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-lg backdrop-blur-sm">
        <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Credits Demo
        </span>
        {STATES.map(([key, label], idx) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveIdx(idx)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              activeIdx === idx
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Root-mounted host for the paid-seat paywall. Subscribes to the module-level
 * paid-seat store (written by the QueryClient's global MutationCache.onError)
 * and renders the dialog when a mutation has failed with `[PAID_SEAT_REQUIRED]`.
 *
 * Must mount inside the org's ProjectContextProvider — the dialog reads org
 * context and the current user's capabilities to pick the role-aware CTA.
 */
import { PaidSeatDialog } from "./paid-seat-dialog.tsx";
import {
  closePaidSeatPaywall,
  usePaidSeatPaywallOpen,
} from "./paid-seat-store.ts";

export function PaidSeatPaywallHost() {
  const open = usePaidSeatPaywallOpen();
  if (!open) return null;
  return <PaidSeatDialog onDismiss={closePaidSeatPaywall} />;
}

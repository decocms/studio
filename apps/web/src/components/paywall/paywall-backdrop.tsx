import { Suspense, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";

/**
 * A populated, inert view to sit BEHIND the paywall.
 *
 * The paywall used to replace the body outright, so the upsell floated over an
 * empty panel — the one screen where the org most needs to see what it would
 * get showed it nothing. This renders the REAL view (never a facsimile) over a
 * throwaway query cache seeded with invented rows.
 *
 * Nothing here can reach the network: the child client has no queries of its
 * own to fetch (`staleTime: Infinity` over pre-seeded keys), and the org cannot
 * read these BFF routes anyway — they answer 403, which is exactly the blank
 * panel this replaces. Inert to the pointer and hidden from screen readers, so
 * the invented rows are decoration and only the dialog is reachable.
 */
export function PaywallBackdrop({
  seed,
  children,
}: {
  /** Writes the mock rows into the throwaway cache before the view mounts. */
  seed: (client: QueryClient) => void;
  children: ReactNode;
}) {
  // Rebuilding this per render would re-seed and remount the view.
  const [client] = useState(() => {
    const next = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Infinity,
          gcTime: Infinity,
          retry: false,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          refetchInterval: false,
        },
      },
    });
    seed(next);
    return next;
  });

  return (
    <div
      aria-hidden="true"
      inert
      className="pointer-events-none absolute inset-0 select-none overflow-hidden"
    >
      {/* A backdrop that crashes must not take the upsell down with it: the
          paywall is a sibling, so this degrades to the old empty panel. */}
      {/* Its OWN suspense boundary — sharing the panel's meant a lazy view
          suspended the dialog too, and the upsell sat behind a spinner. */}
      <ErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

/**
 * Desktop (Tauri) build entry point — loaded ONLY by `index.native.html`,
 * which is ONLY built by the `VITE_TAURI_APP=1` Vite build mode (see
 * `apps/web/vite.config.ts` and `apps/web`'s `build:native` script). The
 * standard web build (`index.html` ->
 * `./index.tsx`) never references this file, so it never reaches the
 * standard bundle's module graph at all.
 *
 * Boots the SAME production shell as `index.tsx` (`@/router` — org
 * switcher, projects, settings, chat, everything), not a parallel mini-app.
 * The local Rust `local-api` process serves this page and stays the only thing
 * the webview talks to: it proxies almost every request upstream unchanged and
 * intercepts only the local concerns (threads, chat dispatch, model/CLI
 * availability, sandbox surfaces). The shell itself needs no desktop-specific
 * transport branch because its relative requests are genuinely same-origin.
 *
 * The ONE desktop-specific thing this entry does beyond that is gate on the
 * OS Keychain's `auth_status` OUTSIDE the shell, exactly like today: the
 * router (and everything it needs — Better Auth cookie session, org data,
 * …) only mounts once `auth_status` says signed in; until then, this shows
 * the sign-in screen instead, never the shell.
 *
 * Boot order matters: `initializeDesktopTransport()` exchanges the one-time
 * IPC bootstrap secret for the local server's HttpOnly session cookie before
 * React mounts. No component can race an unauthenticated local request.
 */
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Providers } from "@/providers/providers";
import { initializeDesktopTransport } from "@/lib/desktop/transport";
import { initializeDesktopWindowOpen } from "@/lib/desktop/window-open-shim";
import { router } from "@/router";
import { useDesktopAuth } from "@/desktop/use-desktop-auth";
import { SignInScreen } from "@/desktop/sign-in-screen";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import { StatusColumn } from "@/desktop/status-column";
import { KeychainUnavailableScreen } from "@/desktop/keychain-unavailable-screen";
import { NativeAgentRuntimeProvider } from "@/desktop/agent-terminal/runtime-provider";

import "../index.css";

// `useDesktopAuth()` below is a `useQuery`/`useQueryClient` consumer, but it
// runs BEFORE the app's own `Providers` (and its `QueryClientProvider`) ever
// mount — that's the whole point of this gate: the shell only mounts once the
// Keychain says we're signed in. Without its own client here, every desktop
// boot crashes at mount with "No QueryClient set, use QueryClientProvider to
// set one" and the DOM never renders (caught live by the boot-smoke DOM-mount
// gate). This client is intentionally separate from the router's — it only
// ever backs the single auth-status gate query, and is discarded once
// `Providers`/`RouterProvider` take over post sign-in.
const authGateQueryClient = new QueryClient();

function DesktopEntry() {
  const auth = useDesktopAuth();

  if (auth.isChecking) {
    return (
      <AuthSplitLayout>
        <StatusColumn />
      </AuthSplitLayout>
    );
  }

  if (auth.status?.storageState === "unavailable") {
    return <KeychainUnavailableScreen auth={auth} />;
  }

  if (!auth.status?.signedIn) {
    return <SignInScreen />;
  }

  // `Providers` wraps the router here (not the root route) so router-level
  // surfaces — `defaultNotFoundComponent`, `defaultPendingComponent` — are
  // inside the QueryClient too, exactly as `index.web.tsx` mounts it.
  return (
    <Providers>
      <NativeAgentRuntimeProvider>
        <RouterProvider router={router} />
      </NativeAgentRuntimeProvider>
    </Providers>
  );
}

const rootElement = document.getElementById("root")!;

function renderDesktopEntry(): void {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={authGateQueryClient}>
        <DesktopEntry />
      </QueryClientProvider>
    </StrictMode>,
  );
}

function renderBootstrapFailure(error: unknown): void {
  createRoot(rootElement).render(
    <AuthSplitLayout>
      <StatusColumn
        error={error instanceof Error ? error.message : String(error)}
      />
    </AuthSplitLayout>,
  );
}

// Before the transport, and deliberately not inside it: this needs no session
// and no local API, so a bootstrap failure must still leave external links
// working on the error screen.
initializeDesktopWindowOpen();

void initializeDesktopTransport().then(
  renderDesktopEntry,
  renderBootstrapFailure,
);

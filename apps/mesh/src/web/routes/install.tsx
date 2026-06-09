import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { usePwaInstall } from "@/web/lib/pwa-install";

/**
 * Neutral install page for deco Studio itself.
 *
 * Lives outside the org shell, so the static "deco Studio" manifest and
 * apple-touch-icon defaults from index.html are active here (the per-org
 * override in use-pwa-manifest.ts only runs inside the org shell). That makes
 * this the one place a logged-in user can install the generic Studio app —
 * "/" always redirects into an org otherwise.
 *
 * Chromium gets the native install prompt; iOS gets Share-sheet instructions;
 * everything else gets a short fallback pointing at the browser's own menu.
 */
function InstallPage() {
  const { canPrompt, installed, ios, promptInstall } = usePwaInstall();
  const [outcome, setOutcome] = useState<string | null>(null);

  const handleInstall = async () => {
    const result = await promptInstall();
    if (result === "accepted") setOutcome("Installing deco Studio…");
    else if (result === "dismissed") setOutcome("Install dismissed.");
    else setOutcome(null);
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <img
          src="/icons/icon-192.png"
          alt="deco Studio"
          className="size-20 rounded-2xl border border-border/50"
        />
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-foreground">
            Install deco Studio
          </h1>
          <p className="text-sm text-muted-foreground">
            Add the full Studio app to your device for a standalone, app-like
            experience. To install a single organization as its own app instead,
            open that org and use your browser's “Add to Home Screen”.
          </p>
        </div>

        {installed ? (
          <p className="rounded-lg bg-muted px-4 py-3 text-sm text-foreground">
            deco Studio is already installed on this device.
          </p>
        ) : ios ? (
          <div className="flex flex-col gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-foreground">
            <p className="font-medium">Install on iOS</p>
            <p className="text-muted-foreground">
              Tap the <span className="font-medium">Share</span> button, then
              choose <span className="font-medium">Add to Home Screen</span>.
            </p>
          </div>
        ) : canPrompt ? (
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={handleInstall}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Install deco Studio
            </button>
            {outcome && (
              <p className="text-sm text-muted-foreground">{outcome}</p>
            )}
          </div>
        ) : (
          <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
            To install, open your browser's menu and choose{" "}
            <span className="font-medium text-foreground">
              Install deco Studio
            </span>{" "}
            (or “Add to Home Screen”). If you don't see it yet, interact with
            the app for a moment and try again.
          </p>
        )}

        <Link
          to="/"
          className="text-sm text-primary hover:underline"
          // Replace so the install page doesn't linger in history between the
          // home redirect and the org route.
          replace
        >
          Back to Studio
        </Link>
      </div>
    </div>
  );
}

export default InstallPage;

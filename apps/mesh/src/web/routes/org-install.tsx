import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useActiveOrganizations } from "@/web/lib/auth-client";
import { usePwaManifest } from "@/web/hooks/use-pwa-manifest";
import { usePwaInstall } from "@/web/lib/pwa-install";

/**
 * Per-org install page (/:org/install).
 *
 * Studio's static "deco Studio" manifest stays active on every other route, so
 * the browser's own "Add to Home Screen" installs Studio itself. This page is
 * the one place that swaps the document manifest to an org-branded one
 * (usePwaManifest), so every install action taken here — the button below, or
 * the browser's native menu — produces a distinct app named after the org that
 * opens straight into /:org.
 *
 * Chromium gets the captured native prompt via the button; iOS gets Share-sheet
 * instructions; anything else falls back to the browser menu (which installs
 * the org too, since the org manifest is active on this page).
 */
function OrgInstallPage() {
  const { org: slug } = useParams({ strict: false });
  const { data: organizations } = useActiveOrganizations();
  const org = organizations?.find((o: { slug: string }) => o.slug === slug);

  // Swap to the org-branded manifest while this page is mounted. Null until the
  // org list resolves; usePwaManifest leaves the Studio defaults in place then.
  usePwaManifest(
    org
      ? {
          name: org.name,
          slug: org.slug,
          logo: (org as { logo?: string | null }).logo ?? null,
        }
      : null,
  );

  const { canPrompt, installed, ios, promptInstall } = usePwaInstall();
  const [outcome, setOutcome] = useState<string | null>(null);

  const name = org?.name ?? "this organization";
  const logo = (org as { logo?: string | null } | undefined)?.logo;

  const handleInstall = async () => {
    const result = await promptInstall();
    if (result === "accepted") setOutcome(`Installing ${name}…`);
    else if (result === "dismissed") setOutcome("Install dismissed.");
    else setOutcome(null);
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <img
          src={logo || "/icons/icon-192.png"}
          alt={name}
          className="size-20 rounded-2xl border border-border/50 object-cover"
        />
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-foreground">
            Add {name} to your Home Screen
          </h1>
          <p className="text-sm text-muted-foreground">
            Install {name} as its own app — a standalone window that opens
            straight into this organization. To install the full deco Studio app
            instead, use your browser's “Add to Home Screen” from any other
            page.
          </p>
        </div>

        {installed ? (
          <p className="rounded-lg bg-muted px-4 py-3 text-sm text-foreground">
            {name} is already installed on this device.
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
              Add {name} to Home Screen
            </button>
            {outcome && (
              <p className="text-sm text-muted-foreground">{outcome}</p>
            )}
          </div>
        ) : (
          <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
            To install, open your browser's menu and choose{" "}
            <span className="font-medium text-foreground">Install {name}</span>{" "}
            (or “Add to Home Screen”). If you don't see it yet, interact with
            the app for a moment and try again.
          </p>
        )}

        <Link
          to="/$org"
          params={{ org: slug ?? "" }}
          className="text-sm text-primary hover:underline"
          // Replace so the install page doesn't linger in history.
          replace
        >
          Back to {name}
        </Link>
      </div>
    </div>
  );
}

export default OrgInstallPage;

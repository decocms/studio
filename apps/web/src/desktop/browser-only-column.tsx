/**
 * The magic-link-only fallback for desktop sign-in surfaces: a deployment
 * whose ONLY enabled method is magic link has no in-app UI at all (magic
 * links open in the system browser and can't hand a session back to the
 * Tauri webview), so instead of the shared form we show a single affordance
 * that reuses the same `auth_login()` system-browser hop as social/SSO.
 * Decision: `needsBrowserOnlyFallback` (`@/desktop/auth-actions`); rendered
 * by `AuthEntry`'s desktop branch. Column content only — the caller's
 * layout (`AuthSplitLayout`) provides the frame.
 */
import { Button } from "@deco/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";

export function BrowserOnlyColumn({
  onContinue,
  isPending,
  error,
}: {
  onContinue: () => Promise<void>;
  isPending: boolean;
  error: string | null;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium text-foreground">
          {t("common.authEntry.browserOnlyTitle")}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("common.authEntry.browserOnlyDescription")}
        </p>
      </div>
      <Button onClick={() => void onContinue()} disabled={isPending}>
        {t("common.authEntry.browserOnlyCta")}
      </Button>
      {error && <p className="max-w-sm text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Shared "something is happening, no form yet" column content for the
 * desktop sign-in flow. Rendered INSIDE `AuthSplitLayout`'s left column by
 * every non-form state (initial `auth_status` check, browser-hop wait,
 * Keychain bridge) so the split-screen frame never pops in/out as the flow
 * transitions between states — see
 * the native authentication-success contract §5.2.
 */
import { Spinner } from "@decocms/ui/components/spinner.tsx";

export function StatusColumn({
  label,
  error,
}: {
  label?: string;
  error?: string | null;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <Spinner size="lg" />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
      {error && <p className="max-w-sm text-xs text-destructive">{error}</p>}
    </div>
  );
}

import { Grid01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import type { SiteTechnology } from "@decocms/shared/site-apps";
import { useT } from "@/i18n/use-t.ts";
import type { AppCatalogEntry } from "./app-catalog";

/**
 * What an app in the catalogue is, before it is installed.
 *
 * Selecting a row opens this; installing happens here, on a button the user
 * aimed at. The row used to BE the button — the whole surface ran the install
 * on a single click, with nothing in between and nothing to read first.
 */
export function AppInstallPanel({
  entry,
  technology,
  blocked,
  isInstalling,
  installError,
  onInstall,
}: {
  entry: AppCatalogEntry;
  /** The stack the writes are built for; null when it isn't known yet. */
  technology: SiteTechnology | null;
  /**
   * Why this session cannot install, when it cannot, and the way out when
   * there is one. Saying it beats a button whose only effect is a toast.
   */
  blocked: {
    reason: string;
    action?: { label: string; onClick: () => void };
  } | null;
  isInstalling: boolean;
  installError: string | null;
  onInstall: () => void;
}) {
  const t = useT();
  const stopped = !entry.installable
    ? { reason: t("sandbox.appInstallPanel.notInstallable") }
    : blocked;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="truncate text-sm font-medium">{entry.title}</span>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="px-6 py-6">
          <div className="mx-auto flex max-w-xl flex-col gap-4">
            <div className="flex items-center gap-3">
              {entry.logo ? (
                <img
                  src={entry.logo}
                  alt=""
                  className="size-12 shrink-0 rounded-xl bg-muted object-cover"
                />
              ) : (
                <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted">
                  <Grid01 size={20} className="text-muted-foreground" />
                </span>
              )}
              <div className="min-w-0">
                <div className="truncate text-base font-medium">
                  {entry.title}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {entry.category}
                </div>
              </div>
            </div>

            {entry.description && (
              <p className="text-sm text-muted-foreground">
                {entry.description}
              </p>
            )}

            {stopped ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-xs text-muted-foreground">
                  {stopped.reason}
                </p>
                {stopped.action && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={stopped.action.onClick}
                  >
                    {stopped.action.label}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {t(
                    technology === "deno"
                      ? "sandbox.appInstallPanel.writesDeno"
                      : "sandbox.appInstallPanel.writesTanstack",
                    { vendor: entry.vendor, app: entry.app },
                  )}
                </p>
                <div>
                  <Button
                    type="button"
                    onClick={onInstall}
                    disabled={isInstalling}
                    className="gap-2"
                  >
                    {isInstalling && <Spinner className="size-3.5" />}
                    {t(
                      isInstalling
                        ? "sandbox.appInstallPanel.installing"
                        : "sandbox.appInstallPanel.install",
                    )}
                  </Button>
                </div>
              </>
            )}

            {installError && (
              <p className="text-xs text-destructive">{installError}</p>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

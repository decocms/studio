import { useId } from "react";
import { Input } from "@decocms/ui/components/input.tsx";
import { SettingsCardRow } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t";

/**
 * The project's site id, read-only. It is set once, by the flow that creates
 * or imports the site, and is the site's public id from then on — CDN paths,
 * site tokens and asset URLs carry it — so no form may change it.
 */
export function ProjectSiteId({
  siteSlug,
  className,
}: {
  siteSlug: string;
  className?: string;
}) {
  const t = useT();
  const id = useId();
  return (
    <SettingsCardRow className={className}>
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {t("virtualMcp.settings.identity.siteId")}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("virtualMcp.settings.identity.siteIdDescription")}
        </p>
      </div>
      <Input id={id} value={siteSlug} readOnly disabled className="font-mono" />
    </SettingsCardRow>
  );
}

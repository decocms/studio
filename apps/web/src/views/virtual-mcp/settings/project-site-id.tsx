import { useId } from "react";
import { Input } from "@decocms/ui/components/input.tsx";
import { SettingsCardRow } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t";
import {
  isValidSiteSlug,
  resolveAgentSiteSlug,
} from "@decocms/shared/site-slug";
import { agentHasClonableSource } from "@/lib/agent-capabilities";

/**
 * The site id to show for a project: its stored (or linked) `siteSlug`, else —
 * for a repo-backed project imported before that key existed — its title,
 * which is the slug in effect until a rename pins it. Chat-only agents have
 * no site, so nothing is shown for them.
 */
export function projectSiteId(project: {
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}): string | null {
  const stored = project.metadata?.siteSlug;
  if (typeof stored === "string" && stored.trim()) return stored;
  if (!agentHasClonableSource(project.metadata)) return null;
  const fromTitle = resolveAgentSiteSlug({ title: project.title });
  return fromTitle && isValidSiteSlug(fromTitle) ? fromTitle : null;
}

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

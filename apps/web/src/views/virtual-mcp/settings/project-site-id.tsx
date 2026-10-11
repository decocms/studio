import { useId } from "react";
import { Check, Copy01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import { cn } from "@decocms/ui/lib/utils.ts";
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
 * site tokens and asset URLs carry it — so no form may change it. Hovering or
 * focusing the row reveals a copy button (always shown on touch screens, which
 * have no hover); the icon turns into a check while the id is on the clipboard.
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
  const { handleCopy, copied } = useCopy();
  return (
    <SettingsCardRow className={cn("group", className)}>
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {t("virtualMcp.settings.identity.siteId")}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("virtualMcp.settings.identity.siteIdDescription")}
        </p>
      </div>
      <div className="relative">
        <Input
          id={id}
          value={siteSlug}
          readOnly
          disabled
          className="pr-10 font-mono"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("virtualMcp.settings.identity.copySiteId")}
          onClick={() => void handleCopy(siteSlug).catch(() => {})}
          className={cn(
            "absolute top-1/2 right-1 -translate-y-1/2 transition-opacity",
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            copied && "opacity-100",
          )}
        >
          {copied ? <Check className="text-success" /> : <Copy01 />}
        </Button>
        <span className="sr-only" aria-live="polite">
          {copied ? t("virtualMcp.settings.identity.siteIdCopied") : ""}
        </span>
      </div>
    </SettingsCardRow>
  );
}

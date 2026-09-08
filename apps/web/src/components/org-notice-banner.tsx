import { AlertTriangle } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectContext } from "@/sdk";
import { useOrgNotice } from "@/hooks/use-org-notice";

/**
 * The strip a `warn` notice puts over the org, and what a blocked org still
 * sees on the billing page it is allowed to reach. Not dismissible: it is a
 * payment warning, and a dismissed one is a warning nobody acted on.
 *
 * Renders nothing when the org has no notice, which is every org but a handful.
 */
export function OrgNoticeBanner() {
  const { org } = useProjectContext();
  const { data: notice } = useOrgNotice(org.slug);

  if (!notice) return null;

  const isBlock = notice.severity === "block";

  return (
    <div
      role="alert"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm",
        isBlock
          ? "border-destructive/25 bg-destructive/5 text-destructive"
          : "border-warning/40 bg-warning/10 text-foreground",
      )}
    >
      {/* `warning-foreground` is the near-white ink for a SOLID warning fill —
          on this tinted background the copy has to be `foreground`, with the
          hue carried by the icon and the border. */}
      <AlertTriangle
        className={cn("size-4 shrink-0", isBlock ? undefined : "text-warning")}
      />
      <span className="font-medium">{notice.title}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">
        {notice.message}
      </span>
      {notice.ctaUrl && notice.ctaLabel ? (
        <Button size="sm" variant="outline" asChild>
          <a href={notice.ctaUrl} target="_blank" rel="noreferrer noopener">
            {notice.ctaLabel}
          </a>
        </Button>
      ) : null}
    </div>
  );
}

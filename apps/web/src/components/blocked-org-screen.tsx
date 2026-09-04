import { AccessScreenLayout } from "@/components/access-screen-layout";
import { Button } from "@decocms/ui/components/button.tsx";
import { AlertTriangle } from "@untitledui/icons";
import type { OrgNoticePublic } from "@decocms/shared/organization/notice";
import { useT } from "@/i18n/use-t.ts";

export interface BlockedOrgScreenProps {
  notice: OrgNoticePublic;
  orgSlug: string;
}

/**
 * What a member of a blocked organization sees instead of the org. Title and
 * body are the operator's own words (see `organization_notices`), so they are
 * rendered as data — only the surrounding chrome is translated.
 *
 * Billing stays reachable from here, and the server keeps that route's tools
 * working while blocked, so the org can settle the notice without support.
 */
export function BlockedOrgScreen({ notice, orgSlug }: BlockedOrgScreenProps) {
  const t = useT();

  return (
    <AccessScreenLayout>
      <div className="bg-destructive/10 p-3 rounded-full">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">{notice.title}</h3>
        <p className="text-sm text-muted-foreground whitespace-pre-line">
          {notice.message}
        </p>
      </div>
      <div className="flex flex-col gap-2 w-full">
        {notice.ctaUrl && notice.ctaLabel ? (
          <Button asChild>
            <a href={notice.ctaUrl} target="_blank" rel="noreferrer noopener">
              {notice.ctaLabel}
            </a>
          </Button>
        ) : null}
        <Button variant="outline" asChild>
          <a href={`/${encodeURIComponent(orgSlug)}/settings/infra-billing`}>
            {t("common.blockedOrgScreen.goToBilling")}
          </a>
        </Button>
        <Button variant="ghost" asChild>
          <a href="/">{t("common.blockedOrgScreen.switchOrg")}</a>
        </Button>
      </div>
    </AccessScreenLayout>
  );
}

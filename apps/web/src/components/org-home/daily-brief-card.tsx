/** The day's brief at the top of the home: an HTML file an automation writes
 *  to the org filesystem. Renders nothing until one exists. */

import { useState } from "react";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { Maximize01 } from "@untitledui/icons";
import {
  briefDay,
  DAILY_BRIEF_VOLUME,
  ORG_BRIEF_DIR,
  personalBriefDir,
} from "@decocms/shared/daily-brief";
import { FilePreview } from "@/components/file-preview";
import { usePreferences } from "@/hooks/use-preferences";
import { useOrgFsDownloadUrl, useOrgFsList } from "@/hooks/use-org-fs";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { LibraryPreviewDialog } from "@/layouts/library/preview-dialog";
import { authClient } from "@/lib/auth-client";
import { type BriefScope, briefsToShow, type ShownBrief } from "./daily-brief";

function ageLabel(t: TFunction, ageDays: number): string {
  if (ageDays === 0) return t("home.dailyBrief.today");
  if (ageDays === 1) return t("home.dailyBrief.yesterday");
  return t("home.dailyBrief.daysAgo", { count: ageDays });
}

function dayLabel(locale: string, day: string): string {
  /** Noon UTC keeps the calendar day in every time zone. */
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function DailyBriefCard() {
  const t = useT();
  const [preferences] = usePreferences();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const org = useOrgFsList(DAILY_BRIEF_VOLUME, ORG_BRIEF_DIR);
  const personal = useOrgFsList(
    DAILY_BRIEF_VOLUME,
    personalBriefDir(userId ?? ""),
    { enabled: !!userId },
  );
  const readUrl = useOrgFsDownloadUrl(DAILY_BRIEF_VOLUME);
  const [scope, setScope] = useState<BriefScope | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const briefs = briefsToShow({
    userId,
    personal: personal.data ?? [],
    org: org.data ?? [],
    today: briefDay(new Date()),
  });
  const brief: ShownBrief | undefined =
    briefs.find((b) => b.scope === scope) ?? briefs[0];
  if (!brief) return null;

  return (
    <section className="flex flex-col overflow-hidden surface">
      <div className="flex h-12 items-center justify-between gap-3 border-b border-border/70 px-5">
        <h2 className="flex min-w-0 items-baseline gap-2 text-[0.9rem] font-medium tracking-tight text-foreground">
          {t("home.dailyBrief.title")}
          <span className="truncate text-xs font-normal text-muted-foreground">
            {ageLabel(t, brief.ageDays)} ·{" "}
            {dayLabel(preferences.language, brief.day)}
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {briefs.length > 1 && (
            <ToggleGroup
              type="single"
              variant="segmented"
              size="sm"
              value={brief.scope}
              onValueChange={(next) => {
                if (next === "personal" || next === "org") setScope(next);
              }}
            >
              <ToggleGroupItem value="personal" className="px-2.5 text-xs">
                {t("home.dailyBrief.personal")}
              </ToggleGroupItem>
              <ToggleGroupItem value="org" className="px-2.5 text-xs">
                {t("home.dailyBrief.org")}
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          <IconButton
            label={t("home.dailyBrief.fullscreen")}
            onClick={() => setFullscreen(true)}
          >
            <Maximize01 size={14} />
          </IconButton>
        </div>
      </div>
      <div className="h-[32rem]">
        <FilePreview
          file={{
            key: brief.path,
            filename: brief.filename,
            size: brief.size,
            downloadUrl: readUrl(brief.path),
          }}
        />
      </div>
      {fullscreen && (
        <LibraryPreviewDialog
          previewPath={`${DAILY_BRIEF_VOLUME}/${brief.path}`}
          onClose={() => setFullscreen(false)}
          showSeeInLibrary
        />
      )}
    </section>
  );
}

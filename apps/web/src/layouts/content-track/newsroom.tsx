/** The newsroom's four roles, with the faces the content track draws them by. */

import { cn } from "@decocms/ui/lib/utils.ts";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";

export type NewsroomRole = "strategist" | "researcher" | "writer" | "creator";

export const NEWSROOM: ReadonlyArray<{
  role: NewsroomRole;
  name: TranslationKey;
  job: TranslationKey;
}> = [
  {
    role: "strategist",
    name: "contentTrack.setup.strategist",
    job: "contentTrack.setup.strategistJob",
  },
  {
    role: "researcher",
    name: "contentTrack.setup.researcher",
    job: "contentTrack.setup.researcherJob",
  },
  {
    role: "writer",
    name: "contentTrack.setup.writer",
    job: "contentTrack.setup.writerJob",
  },
  {
    role: "creator",
    name: "contentTrack.setup.creator",
    job: "contentTrack.setup.creatorJob",
  },
];

const ROLE_NAME = Object.fromEntries(
  NEWSROOM.map(({ role, name }) => [role, name]),
) as Record<NewsroomRole, TranslationKey>;

export function RoleAvatar({
  role,
  className,
}: {
  role: NewsroomRole;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "block size-10 shrink-0 overflow-hidden rounded-[10px] bg-[#F3EEE2] shadow-sm",
        className,
      )}
    >
      <img
        src={`/content-track/agents/${role}.webp`}
        alt=""
        className="size-full object-cover"
      />
    </span>
  );
}

/** A role at work on part of the card: its face, its name, what it is doing. */
export function RoleAtWork({
  role,
  activity,
}: {
  role: NewsroomRole;
  activity: string;
}) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-3 shadow-edge">
      <RoleAvatar role={role} className="size-6 rounded-full" />
      <span className="flex flex-col leading-tight">
        <span className="text-xs font-semibold text-foreground">
          {t(ROLE_NAME[role])}
        </span>
        <span className="text-[11px] text-muted-foreground">{activity}</span>
      </span>
      <span className="size-1.5 animate-pulse rounded-full bg-success" />
    </span>
  );
}

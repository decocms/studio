/**
 * "Learn the Site Editor" — a link to the CMS-training video playlist, shown on
 * the org home only for orgs that own a legacy deco.cx site (`org_sites`), the
 * ones the training is about. Opens in a new tab; the whole card is the link.
 */

import { ArrowRight } from "@untitledui/icons";
import { useOrgHasSite } from "@/hooks/use-org-has-site";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLZ4WtTgnJfBw";

/** YouTube brand mark — red badge, white play triangle. Brand colors, not
 *  design-system tokens (same rule as the client marks in ConnectPill). */
function YouTubeLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 20"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#FF0000"
        d="M27.4 3.1c-.3-1.2-1.3-2.2-2.5-2.5C22.7 0 14 0 14 0S5.3 0 3.1.6C1.9.9.9 1.9.6 3.1.1 5.3 0 8 0 10s.1 4.7.6 6.9c.3 1.2 1.3 2.2 2.5 2.5C5.3 20 14 20 14 20s8.7 0 10.9-.6c1.2-.3 2.2-1.3 2.5-2.5.5-2.2.6-4.9.6-6.9s-.1-4.7-.6-6.9z"
      />
      <path fill="#fff" d="M11.2 14.3l7.3-4.3-7.3-4.3z" />
    </svg>
  );
}

export function TrainingCard() {
  const t = useT();
  const { hasSite } = useOrgHasSite();

  if (!hasSite) return null;

  return (
    <a
      href={PLAYLIST_URL}
      target="_blank"
      rel="noreferrer"
      onClick={() => track("cms_training_opened", { source: "org_home" })}
      className="group card-shadow flex w-full items-center gap-4 rounded-xl bg-card p-3 text-left transition-colors hover:bg-accent/60"
    >
      <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-lg">
        <img
          src="/cms-training.jpg"
          alt={t("home.orgHome.trainingThumbnailAlt")}
          className="size-full object-cover"
        />
        <span className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors group-hover:bg-black/20">
          <YouTubeLogo className="w-9" />
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          {t("home.orgHome.trainingEyebrow")}
        </p>
        <h3 className="text-sm font-medium text-foreground">
          {t("home.orgHome.trainingTitle")}
        </h3>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {t("home.orgHome.trainingDescription")}
        </p>
      </div>

      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </a>
  );
}

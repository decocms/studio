import type { Release } from "@/web/lib/release-feed";
import { Button } from "@deco/ui/components/button.tsx";

export interface ReleaseCardProps {
  release: Release;
  onCtaClick?: () => void;
  onLearnMoreClick?: () => void;
}

export function ReleaseCard({
  release,
  onCtaClick,
  onLearnMoreClick,
}: ReleaseCardProps) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        {release.eyebrow && (
          <p className="text-xs text-muted-foreground">{release.eyebrow}</p>
        )}
        <h3 className="text-base font-semibold text-foreground">
          {release.title}
        </h3>
      </div>

      <ul className="flex flex-col gap-3">
        {release.bullets.map((bullet, idx) => (
          <li key={idx} className="flex items-start gap-3">
            <bullet.icon
              size={20}
              className="text-muted-foreground mt-0.5 shrink-0"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {bullet.title}
              </p>
              <p className="text-xs text-muted-foreground">{bullet.body}</p>
            </div>
          </li>
        ))}
      </ul>

      {(release.cta || release.learnMoreHref) && (
        <div className="flex items-center justify-between pt-1">
          {release.learnMoreHref ? (
            <a
              href={release.learnMoreHref}
              target="_blank"
              rel="noreferrer"
              onClick={onLearnMoreClick}
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              Learn More
            </a>
          ) : (
            <span />
          )}
          {release.cta && (
            <Button asChild size="sm" onClick={onCtaClick}>
              <a href={release.cta.href}>{release.cta.label}</a>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

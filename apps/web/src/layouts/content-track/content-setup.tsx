/**
 * What the content track shows until the brand can be written for: what the
 * newsroom is, what the brand guide still lacks, and the way to it.
 */

import { useNavigate } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  ArrowRight,
  Edit05,
  Image01,
  SearchMd,
  Target04,
} from "@untitledui/icons";
import type { BrandRequirement } from "@/components/sandbox/content/blog/blog-data";
import { REQUIREMENT_LABEL } from "@/components/sandbox/content/blog/generate-post-dialog";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";

const ROLES = [
  {
    icon: Target04,
    name: "contentTrack.setup.strategist",
    job: "contentTrack.setup.strategistJob",
  },
  {
    icon: SearchMd,
    name: "contentTrack.setup.researcher",
    job: "contentTrack.setup.researcherJob",
  },
  {
    icon: Edit05,
    name: "contentTrack.setup.writer",
    job: "contentTrack.setup.writerJob",
  },
  {
    icon: Image01,
    name: "contentTrack.setup.creator",
    job: "contentTrack.setup.creatorJob",
  },
] as const;

const LOOP = [
  "contentTrack.setup.loopContext",
  "contentTrack.setup.loopHypothesis",
  "contentTrack.setup.loopExecute",
  "contentTrack.setup.loopMonitor",
] as const;

export function ContentSetup({ missing }: { missing: BrandRequirement[] }) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return (
    <section className="flex flex-col gap-6 rounded-2xl bg-brand-lime-tint p-6 dark:bg-brand/15">
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-brand-green-dark dark:text-brand">
          {t("contentTrack.setup.eyebrow")}
        </span>
        <h2 className="text-xl font-semibold text-foreground">
          {t("contentTrack.setup.title")}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("contentTrack.setup.description")}
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {ROLES.map(({ icon: Icon, name, job }) => (
          <li
            key={name}
            className="flex flex-col gap-1 rounded-xl bg-card p-3 shadow-edge"
          >
            <Icon size={16} className="text-brand-green-dark dark:text-brand" />
            <span className="text-sm font-medium text-foreground">
              {t(name)}
            </span>
            <span className="text-xs text-muted-foreground">{t(job)}</span>
          </li>
        ))}
      </ul>
      <ol className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {LOOP.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            {index > 0 && <ArrowRight size={14} aria-hidden />}
            <span className={cn(index === 0 && "font-medium text-foreground")}>
              {t(step)}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-foreground">
          {t("contentTrack.setup.missing", {
            fields: missing
              .map((field) => t(REQUIREMENT_LABEL[field]))
              .join(", "),
          })}
        </p>
        <Button
          variant="brand"
          onClick={() =>
            navigate({
              to: "/$org/library",
              params: { org: org.slug },
              search: { section: "brand" },
            })
          }
        >
          {t("contentTrack.setup.activate")}
        </Button>
      </div>
    </section>
  );
}

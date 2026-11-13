/**
 * Plan opens on the map of the store. Starting a plan offers three ways in,
 * from the most specific to the most open; none of them is wired yet.
 */

import { useState, type ComponentType, type ReactNode } from "react";
import {
  ArrowRight,
  BarChartSquare02,
  Compass03,
  Lightbulb02,
  Plus,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Page } from "@/components/page";
import { useT } from "@/i18n/use-t.ts";
import { useAnalyticsStatus } from "@/components/monitor/deco-analytics";
import { useSiteProjects } from "@/components/monitor/monitor-views";
import { siteOrigin } from "@/layouts/main-panel-tabs/analytics-heatmap-model.ts";
import { useProjectContext } from "@/sdk";
import { Panel } from "@/components/panel";
import { GoalsView, type YearRevenue } from "./goals-view.tsx";
import { SiteMap, type MapStore } from "./site-map.tsx";
import type { TranslationKey } from "@/i18n/use-t.ts";

type Icon = ComponentType<{ size?: number; className?: string }>;

const TOPICS: TranslationKey[] = [
  "plan.topic.shipping",
  "plan.topic.pdp",
  "plan.topic.home",
  "plan.topic.search",
  "plan.topic.minicart",
  "plan.topic.plp",
  "plan.topic.checkout",
  "plan.topic.payment",
  "plan.topic.promotions",
  "plan.topic.recommendations",
  "plan.topic.reviews",
  "plan.topic.performance",
  "plan.topic.seo",
  "plan.topic.mobile",
  "plan.topic.account",
  "plan.topic.accessibility",
];

const REPORT_POINTS: TranslationKey[] = [
  "plan.full.pointFunnel",
  "plan.full.pointPerformance",
  "plan.full.pointSeo",
  "plan.full.pointPriorities",
];

function Column({
  Icon,
  tone,
  title,
  description,
  action,
  children,
}: {
  Icon: Icon;
  tone: string;
  title: string;
  description: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-[26rem] flex-col gap-5 surface p-5">
      <div className="flex flex-col gap-3">
        <span
          className={cn(
            "flex size-9 items-center justify-center rounded-lg",
            tone,
          )}
        >
          <Icon size={18} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium text-foreground">{title}</h2>
          <p className="text-sm text-pretty text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="flex flex-1 flex-col">{children}</div>
      {action}
    </section>
  );
}

/**
 * The report, framed against the current project's site, or the org's first
 * site when the plan is opened from the org. The domain is the one the heatmap
 * frames.
 */
function PlanReport({
  store,
  leading,
}: {
  store: MapStore;
  leading: ReactNode;
}) {
  const { org, project } = useProjectContext();
  const projects = useSiteProjects();
  const site = projects.find((item) => item.id === project.id) ?? projects[0];
  const status = useAnalyticsStatus(
    org.slug,
    { analyticsSite: site?.analyticsSite ?? "" },
    site !== undefined,
  );
  const origin = siteOrigin(
    status.data?.config?.domains?.[0] ?? status.data?.host,
  );
  return <SiteMap store={store} origin={origin} leading={leading} />;
}

/** The three ways to start a plan; none of them is wired yet. */
function PlanOptions({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [selected, setSelected] = useState<ReadonlySet<TranslationKey>>(
    () => new Set(),
  );
  const toggle = (topic: TranslationKey) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(topic)) next.add(topic);
      return next;
    });

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Column
        Icon={Lightbulb02}
        tone="bg-chart-4/15 text-chart-4"
        title={t("plan.idea.title")}
        description={t("plan.idea.description")}
        action={
          <Button className="w-full">
            {t("plan.idea.action")}
            <ArrowRight />
          </Button>
        }
      >
        <Textarea
          aria-label={t("plan.idea.title")}
          placeholder={t("plan.idea.placeholder")}
          className="min-h-48 flex-1 resize-none"
        />
      </Column>
      <Column
        Icon={Compass03}
        tone="bg-chart-2/15 text-chart-2"
        title={t("plan.direction.title")}
        description={t("plan.direction.description")}
        action={
          <Button variant="outline" className="w-full">
            {t("plan.direction.action")}
            <ArrowRight />
          </Button>
        }
      >
        <div className="flex flex-wrap content-start gap-2">
          {TOPICS.map((topic) => (
            <Button
              key={topic}
              variant="outline"
              size="sm"
              className="aria-pressed:bg-brand-lime-tint aria-pressed:text-brand-green-dark aria-pressed:shadow-[inset_0_0_0_1px_var(--brand)] aria-pressed:hover:bg-brand-lime-tint dark:aria-pressed:bg-brand/20 dark:aria-pressed:text-brand"
              aria-pressed={selected.has(topic)}
              onClick={() => toggle(topic)}
            >
              {t(topic)}
            </Button>
          ))}
        </div>
      </Column>
      <Column
        Icon={BarChartSquare02}
        tone="bg-chart-1/15 text-chart-1"
        title={t("plan.full.title")}
        description={t("plan.full.description")}
        action={
          <Button variant="outline" className="w-full" onClick={onDone}>
            {t("plan.full.action")}
            <ArrowRight />
          </Button>
        }
      >
        <ul className="flex flex-col gap-2.5">
          {REPORT_POINTS.map((point) => (
            <li
              key={point}
              className="flex items-center gap-2.5 text-sm text-foreground"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-chart-1" />
              {t(point)}
            </li>
          ))}
        </ul>
      </Column>
    </div>
  );
}

type PlanView = "map" | "goals";

/**
 * An org's file through the Studio that is open: the stored URL names the
 * deployment that uploaded it, which a local or preview Studio can't read
 * with its own session.
 */
function orgFileUrl(url: string | null, orgSlug: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname.startsWith(`/api/${orgSlug}/files/`)
      ? `${parsed.pathname}${parsed.search}`
      : url;
  } catch {
    return url;
  }
}

/** Map and Goals, in the panel's toolbar like the Monitor's views. */
function PlanTabs({
  view,
  onView,
}: {
  view: PlanView;
  onView: (view: PlanView) => void;
}) {
  const t = useT();
  const tabs = (
    <Page.Tabs>
      <Page.Tab active={view === "map"} onClick={() => onView("map")}>
        {t("plan.view.map")}
      </Page.Tab>
      <Page.Tab active={view === "goals"} onClick={() => onView("goals")}>
        {t("plan.view.goals")}
      </Page.Tab>
    </Page.Tabs>
  );
  return (
    <Panel.Toolbar.Left.Portal fallback={tabs}>
      {tabs}
    </Panel.Toolbar.Left.Portal>
  );
}

export function PlanPage() {
  const t = useT();
  const { org } = useProjectContext();
  const [view, setView] = useState<PlanView>("map");
  const [goals, setGoals] = useState<YearRevenue[] | null>(null);
  const [starting, setStarting] = useState(false);
  const store = { name: org.name, logo: orgFileUrl(org.logo, org.slug) };
  return (
    <Page>
      <PlanTabs view={view} onView={setView} />
      {view === "map" ? (
        <PlanReport
          store={store}
          leading={
            <Button variant="brand" size="sm" onClick={() => setStarting(true)}>
              <Plus />
              {t("plan.start")}
            </Button>
          }
        />
      ) : (
        <GoalsView store={store} goals={goals} onGoals={setGoals} />
      )}
      <Dialog open={starting} onOpenChange={setStarting}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>{t("plan.heading")}</DialogTitle>
            <DialogDescription>{t("plan.description")}</DialogDescription>
          </DialogHeader>
          <PlanOptions onDone={() => setStarting(false)} />
        </DialogContent>
      </Dialog>
    </Page>
  );
}

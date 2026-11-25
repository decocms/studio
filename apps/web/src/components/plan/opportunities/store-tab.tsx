/**
 * Plan's store tab: the latest analysis of each page, as a funnel from home
 * to checkout, and one page at a time with its first screen, its measured
 * losses and what the analysis saw there.
 */

import { useState } from "react";
import { ArrowRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import { formatRelativeTime } from "@/lib/format-time.ts";
import { ConnectCard } from "./connect-card.tsx";
import type { PageType, StoreView } from "./diagnosis-schema.ts";
import { FunnelStageCard } from "./funnel-stage-card.tsx";
import { EngineImage } from "./hypothesis-card.tsx";
import { PAGE_LABEL, stageLabel } from "./labels.ts";
import {
  type RunGoal,
  RunRequestNotice,
  useRequestRun,
} from "./new-run-popover.tsx";
import { NewRunButton, SectionError } from "./opportunities-section.tsx";
import { LossBadges, tallyText } from "./opportunity-card.tsx";
import {
  defaultStorePage,
  errorText,
  formatMoney,
  pageLosses,
  safeImageSrc,
  showsAnalysedAt,
  stageCards,
} from "./opportunity-view.ts";
import { usePlanDiagnosisStatus, useStoreView } from "./use-plan-diagnosis.ts";

type Device = "mobile" | "desktop";

export interface StoreTabProps {
  goal: RunGoal;
  /** Opens "Nova análise" beside the button that was clicked. */
  onNewRun?: (anchor: HTMLElement) => void;
  onOpenOpportunity?: (opportunityId: string) => void;
}

function StoreSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-3 w-56" />
      <Skeleton className="h-6 w-72" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {["a", "b", "c", "d", "e"].map((k) => (
          <Skeleton key={k} className="h-40 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}

function Header({
  device,
  onDevice,
  onNewRun,
}: {
  device: Device;
  onDevice: (device: Device) => void;
  onNewRun?: (anchor: HTMLElement) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("plan.opportunities.store.eyebrow")}
        </p>
        <h2 className="text-xl font-medium text-foreground">
          {t("plan.opportunities.store.heading")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {device === "mobile"
            ? t("plan.opportunities.store.description.mobile")
            : t("plan.opportunities.store.description.desktop")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ToggleGroup
          type="single"
          variant="segmented"
          size="sm"
          aria-label={t("plan.opportunities.store.device")}
          value={device}
          onValueChange={(next) => {
            if (next === "mobile" || next === "desktop") onDevice(next);
          }}
        >
          <ToggleGroupItem value="mobile" className="px-2.5 text-xs">
            {t("plan.opportunities.device.mobile")}
          </ToggleGroupItem>
          <ToggleGroupItem value="desktop" className="px-2.5 text-xs">
            {t("plan.opportunities.device.desktop")}
          </ToggleGroupItem>
        </ToggleGroup>
        <NewRunButton onNewRun={onNewRun} />
      </div>
    </div>
  );
}

/** The page's first screen in a phone or a desktop frame. The engine signs
 *  the image for an hour, so a failed load says it expired. */
function Capture({
  src,
  device,
  page,
}: {
  src: string | null;
  device: Device;
  page: PageType;
}) {
  const t = useT();
  const image = (
    <EngineImage
      src={src}
      alt={t("plan.opportunities.store.capture.alt", {
        page: t(PAGE_LABEL[page]),
      })}
      className="max-h-none size-full rounded-none border-0 object-cover object-top"
    />
  );
  const placeholder = (
    <span className="flex size-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
      {t("plan.opportunities.store.capture.none")}
    </span>
  );
  return (
    <figure className="flex flex-col items-center gap-3">
      <div
        className={cn(
          "flex items-center justify-center overflow-hidden bg-muted text-xs text-muted-foreground [&>p]:p-4 [&>p]:text-center",
          device === "mobile"
            ? "aspect-[9/19] w-56 rounded-[2rem] border-4 border-foreground/80"
            : "aspect-[16/10] w-full rounded-lg border-4 border-t-[14px] border-foreground/80",
        )}
      >
        {safeImageSrc(src) ? image : placeholder}
      </div>
      <figcaption className="text-xs text-muted-foreground">
        {t("plan.opportunities.store.capture.caption")}
      </figcaption>
    </figure>
  );
}

function PagePanel({
  view,
  pageType,
  device,
  goal,
  onOpenOpportunity,
}: {
  view: StoreView;
  pageType: PageType;
  device: Device;
  goal: RunGoal;
  onOpenOpportunity?: (opportunityId: string) => void;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const run = useRequestRun(goal);
  const page = view.pages.find((p) => p.page_type === pageType);
  const losses = pageLosses(view, pageType);
  const running = page?.status === "running";
  const stageKey = page?.stage ? stageLabel(page.stage) : null;
  const biggest = losses[0];

  return (
    <Card size="flush" className="grid overflow-hidden md:grid-cols-[2fr_3fr]">
      <div className="border-b border-border bg-muted/30 p-5 md:border-r md:border-b-0">
        <Capture
          src={page?.capture_url ?? null}
          device={device}
          page={pageType}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="text-base font-medium text-foreground">
              {t(PAGE_LABEL[pageType])}
            </h3>
            {page && showsAnalysedAt(view, page) && (
              <span className="text-sm text-muted-foreground">
                {t("plan.opportunities.store.analysed", {
                  when: formatRelativeTime(
                    new Date(page.analysed_at),
                    language,
                  ),
                })}
              </span>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={running || run.blocked}
            onClick={() => run.request([pageType])}
          >
            {run.pending && <Spinner size="2xs" />}
            {t("plan.opportunities.store.redo")}
          </Button>
        </div>

        <RunRequestNotice
          error={run.error}
          elsewhere={run.elsewhere}
          onDomainSaved={run.retry}
        />

        {running && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
          >
            <Spinner size="2xs" />
            {t("plan.opportunities.store.pageRunning")}
            {page?.stage && (
              <span className="text-xs text-muted-foreground">
                {stageKey ? t(stageKey) : page.stage}
              </span>
            )}
          </p>
        )}
        {page?.status === "error" && page.progress_note && (
          <p className="text-sm text-destructive">
            {`${t("plan.opportunities.running.failed")}: ${page.progress_note}`}
          </p>
        )}

        {!page ? (
          <p className="text-sm text-muted-foreground">
            {t("plan.opportunities.store.notAnalysed")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-muted-foreground">
              {t("plan.opportunities.store.losses")}
            </span>
            {losses.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("plan.opportunities.store.noLosses")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {losses.map((o) => {
                  const body = (
                    <>
                      <span className="flex items-start justify-between gap-4">
                        <span className="text-sm font-medium text-foreground">
                          {o.title}
                        </span>
                        {o.money && (
                          <span className="shrink-0 text-sm font-medium text-foreground">
                            {formatMoney(o.money.monthly_value, language)}
                          </span>
                        )}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <LossBadges opportunity={o} />
                        <span className="text-xs text-muted-foreground">
                          {tallyText(t, o)}
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <li key={o.id}>
                      {onOpenOpportunity ? (
                        <button
                          type="button"
                          onClick={() => onOpenOpportunity(o.id)}
                          className="flex w-full flex-col gap-2 rounded-lg bg-muted px-4 py-3 text-left hover:bg-muted/70 focus-ring"
                        >
                          {body}
                        </button>
                      ) : (
                        <div className="flex flex-col gap-2 rounded-lg bg-muted px-4 py-3">
                          {body}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {page && page.observations.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-muted-foreground">
              {t("plan.opportunities.store.observed")}
            </span>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-foreground">
              {page.observations.map((text, i) => (
                // Engine text can repeat, so the position keeps keys unique.
                <li key={`${i}:${text}`}>{text}</li>
              ))}
            </ul>
          </div>
        )}

        {page && page.gaps.length > 0 && (
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {t("plan.opportunities.summary.gaps")}
            </span>
            <ul className="flex flex-col gap-0.5 text-warning">
              {page.gaps.map((gap, i) => (
                <li key={`${i}:${gap}`}>{gap}</li>
              ))}
            </ul>
          </div>
        )}

        {biggest && onOpenOpportunity && (
          <Button
            className="mt-auto self-start"
            onClick={() => onOpenOpportunity(biggest.id)}
          >
            {t("plan.opportunities.store.openBiggest")}
            <ArrowRight />
          </Button>
        )}
      </div>
    </Card>
  );
}

function StoreContent({ goal, onNewRun, onOpenOpportunity }: StoreTabProps) {
  const t = useT();
  const query = useStoreView(goal);
  const [device, setDevice] = useState<Device>("mobile");
  const [picked, setPicked] = useState<PageType | null>(null);
  const view = query.data;
  const retry = () => void query.refetch();

  if (query.isPending) return <StoreSkeleton />;
  if (!view) {
    return <SectionError error={errorText(query.error)} retry={retry} />;
  }

  const header = (
    <Header device={device} onDevice={setDevice} onNewRun={onNewRun} />
  );
  const stale = query.isError && (
    <SectionError
      headline={t("plan.opportunities.error.stale")}
      error={errorText(query.error)}
      retry={retry}
    />
  );
  const selected = picked ?? defaultStorePage(view);

  if (view.pages.length === 0) {
    return (
      <section className="flex flex-col gap-4">
        {header}
        {stale}
        <Card className="items-start gap-3">
          <h3 className="text-base font-medium text-foreground">
            {t("plan.opportunities.store.empty.heading")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("plan.opportunities.store.empty.description")}
          </p>
          <NewRunButton onNewRun={onNewRun} />
        </Card>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      {header}
      {stale}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {stageCards(view, device).map((card) => (
          <FunnelStageCard
            key={card.page_type}
            card={card}
            selected={card.page_type === selected}
            onSelect={() => setPicked(card.page_type)}
          />
        ))}
      </div>
      {selected && (
        <PagePanel
          key={selected}
          view={view}
          pageType={selected}
          device={device}
          goal={goal}
          onOpenOpportunity={onOpenOpportunity}
        />
      )}
    </section>
  );
}

/** The same gate as the "Found for you" section; where this deployment has
 *  no analysis, the tab says so instead of staying blank. */
export function StoreTab(props: StoreTabProps) {
  const t = useT();
  const status = usePlanDiagnosisStatus();
  switch (status.state) {
    case "loading":
      return <StoreSkeleton />;
    case "error":
      return <SectionError error={status.error} retry={status.retry} />;
    case "unconfigured":
      return status.reason === "not_connected" ? (
        <ConnectCard />
      ) : (
        <Card className="items-start gap-1">
          <h3 className="text-base font-medium text-foreground">
            {t("plan.opportunities.detail.unavailable.heading")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("plan.opportunities.store.unavailable")}
          </p>
        </Card>
      );
    case "configured":
      // A new goal starts on its own default page.
      return <StoreContent key={props.goal.id ?? "all"} {...props} />;
  }
}

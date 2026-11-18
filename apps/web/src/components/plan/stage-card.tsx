/**
 * One funnel stage opened: the store's live page for it, framed the same way
 * the heatmap frames it, beside what the agents found on that page.
 */

import { useState, type FormEvent } from "react";
import { LinkExternal01, RefreshCw01, XClose } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import { frameUrl } from "@/layouts/main-panel-tabs/analytics-heatmap-model.ts";
import type { MapNode } from "./site-map-mock.ts";
import { STATUS_BADGE, STATUS_LABEL, StatusDot } from "./status.tsx";

/** The desktop width the heatmap renders at when it has no measured viewport. */
const FRAME_WIDTH = 1440;

function PagePreview({ origin, path }: { origin: string; path: string }) {
  const t = useT();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState(false);
  const src = frameUrl(origin, path);

  const measure = (element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setBox({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  };

  const scale = box.width ? box.width / FRAME_WIDTH : 0;
  return (
    <div
      ref={measure}
      className="relative min-h-0 flex-1 overflow-hidden rounded-t-lg border border-b-0 border-border bg-background"
    >
      {src && scale > 0 && (
        <iframe
          title={t("plan.stage.frameTitle")}
          src={src}
          onLoad={() => setLoaded(true)}
          // oxlint-disable-next-line react/iframe-missing-sandbox -- same frame as the heatmap: the site is cross-origin to Studio and keeps its own origin; the sandbox still blocks top navigation, popups and forms
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute top-0 left-0 border-0 bg-background transition-opacity"
          style={{
            width: FRAME_WIDTH,
            height: box.height / scale,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            opacity: loaded ? 1 : 0.35,
          }}
        />
      )}
      {src && !loaded && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner size="xs" />
          {t("plan.stage.loading")}
        </div>
      )}
      {!src && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("plan.stage.invalidPath")}
        </div>
      )}
    </div>
  );
}

export function StageCard({
  stage,
  origin,
  onClose,
}: {
  stage: MapNode;
  /** The store's registered origin; null when the site has none. */
  origin: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  const [path, setPath] = useState(stage.path ?? "/");
  const [draft, setDraft] = useState(path);
  const opportunities = stage.opportunities ?? [];
  const open = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    setPath(next.startsWith("/") ? next : `/${next}`);
  };
  const live = origin ? new URL(path, origin).href : null;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden surface">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-base font-medium text-foreground">
            {stage.label}
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("plan.funnel.sessionsPeriod", {
              count: new Intl.NumberFormat(language).format(
                stage.sessions ?? 0,
              ),
            })}
          </span>
        </div>
        {origin && (
          <form
            onSubmit={open}
            className="ml-auto flex min-w-0 items-center gap-2"
          >
            <Input
              size="sm"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={t("plan.stage.path")}
              className="w-64 font-mono text-xs"
            />
            {live && (
              <Button variant="ghost" size="icon-sm" asChild>
                <a
                  href={live}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("plan.stage.openLive")}
                >
                  <LinkExternal01 />
                </a>
              </Button>
            )}
          </form>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("plan.stage.close")}
          onClick={onClose}
          className={cn(!origin && "ml-auto")}
        >
          <XClose />
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-h-[320px] min-w-0 flex-col surface-inset rounded-none px-4 pt-4">
          {origin ? (
            <PagePreview key={path} origin={origin} path={path} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {t("plan.stage.noDomain")}
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-border p-4">
          <h3 className="text-sm font-medium text-foreground">
            {t("plan.stage.opportunities", { count: opportunities.length })}
          </h3>
          <ul className="flex flex-col gap-2">
            {opportunities.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3"
              >
                <div className="flex items-center gap-2">
                  {item.status && <StatusDot status={item.status} />}
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                    {item.label}
                  </span>
                  {item.status && (
                    <Badge variant={STATUS_BADGE[item.status]}>
                      {t(STATUS_LABEL[item.status])}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-pretty text-muted-foreground">
                  {item.note ?? t("plan.map.doneDescription")}
                </p>
                {item.status === "done" ? (
                  <Button variant="outline" size="xs" className="w-fit">
                    <RefreshCw01 />
                    {t("plan.map.revalidate")}
                  </Button>
                ) : (
                  <Button size="xs" className="w-fit">
                    {t("plan.map.createTask")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

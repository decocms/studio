/**
 * A Monitor view inside the main panel's clipping body (chat-layout's content
 * wrapper: a fixed height with `overflow-hidden`), so a test can scroll it the
 * way a visitor does.
 *
 * `tall` is a view that doesn't scroll on its own, like the Experiments
 * results inside their project's `h-full` wrapper; `scroller` is one with its
 * own `overflow-auto`, like Logs or Analytics.
 */

import { MonitorFrame } from "@/components/monitor/monitor-frame";

export function MonitorFrameHarness({ view }: { view: "tall" | "scroller" }) {
  const content = (
    <div className="flex flex-col gap-4 p-4">
      <div style={{ height: 1500 }}>Começo</div>
      <p data-testid="end">Fim</p>
    </div>
  );
  return (
    <div className="flex flex-col" style={{ height: 400 }}>
      <div data-testid="panel" className="min-h-0 flex-1 overflow-hidden">
        <MonitorFrame tabs={<nav style={{ height: 40 }}>Abas</nav>}>
          {view === "tall" ? (
            <div className="flex h-full min-h-0 flex-col">{content}</div>
          ) : (
            <div
              data-testid="own"
              className="flex h-full min-h-0 flex-col overflow-auto"
            >
              {content}
            </div>
          )}
        </MonitorFrame>
      </div>
    </div>
  );
}

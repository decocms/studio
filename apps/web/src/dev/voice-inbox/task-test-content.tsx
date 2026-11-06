import { Button } from "@decocms/ui/components/button.tsx";
import { PrCard } from "@/layouts/task-board/task-dialog";
import { PreviewButton } from "@/layouts/task-board/preview-button";
import { previewRouteUrl } from "@/layouts/task-board/preview-routes";
import { useT } from "@/i18n/use-t";
import type { MockTask } from "./data";

export function TaskTestContent({ task }: { task: MockTask }) {
  const t = useT();
  const plan = task.review?.testPlan;
  const pr = task.pullRequest;
  return (
    <div className="flex flex-col gap-5">
      {plan && (
        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">
                {t("voiceInbox.howToTest")}
              </h3>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {plan.route}
              </p>
            </div>
            {pr?.previewUrl && (
              <PreviewButton
                url={previewRouteUrl(pr.previewUrl, plan.route)}
                routes={[]}
              />
            )}
          </div>
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            {plan.steps.map((step) => (
              <li key={step.action} className="pl-1">
                <span>{step.action}</span>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  {t("voiceInbox.expectedResult")} {step.expected}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
      {pr && (
        <section className="border-t pt-4">
          <p className="mb-2 text-xs text-muted-foreground">
            {t("voiceInbox.prSnapshot")}
          </p>
          <PrCard
            pr={pr}
            routes={plan ? [plan.route] : []}
            revalidating={false}
            readyToShip={false}
            shipPending={false}
            resolvePending={false}
            onShip={() => {}}
            onResolveConflict={() => {}}
          />
          {!pr.previewUrl && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("voiceInbox.previewNotReported")}
            </p>
          )}
        </section>
      )}
      {!pr && task.review?.link && (
        <Button asChild variant="outline">
          <a href={task.review.link.url} target="_blank" rel="noreferrer">
            {task.review.link.label}
          </a>
        </Button>
      )}
    </div>
  );
}

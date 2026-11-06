import { AlertTriangle } from "@untitledui/icons";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { changeId } from "./cms-publish-change-card.tsx";
import {
  type PublishRequiredFields,
  requiredFieldLabel,
} from "./publish-required-fields.ts";

/** Changes listed, and fields per change, before "and N more". */
const LISTED_CHANGES = 5;
const LISTED_FIELDS = 4;

/**
 * The Publish dialog's row for required fields the changes leave empty, by
 * change: missing ones stop a Publish (`blocking`), blank ones only warn.
 */
export function PublishRequiredFieldsRow({
  found,
  checking,
  blocking,
  review,
}: {
  found: readonly PublishRequiredFields[];
  /** The changes' content is still loading, so they can't be judged yet. */
  checking: boolean;
  blocking: boolean;
  /** Submitting for review publishes nothing, so nothing is stopped. */
  review: boolean;
}) {
  const t = useT();
  if (checking) {
    return (
      <div className="flex items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <Spinner className="size-3.5 motion-reduce:animate-none" />
        {t("thread.publishPopover.requiredFieldsChecking")}
      </div>
    );
  }
  if (found.length === 0) return null;
  const missing = found.some(({ fields }) => fields.some((f) => f.blocks));
  // Changes with missing fields first, so "and N more" never hides one that holds the Publish.
  const listed = [...found].sort(
    (a, b) =>
      Number(b.fields.some((f) => f.blocks)) -
      Number(a.fields.some((f) => f.blocks)),
  );
  const more = (count: number) =>
    count > 0 ? t("thread.publishPopover.requiredFieldsMore", { count }) : null;
  return (
    <div
      className={cn(
        "space-y-1.5 border-t px-4 py-2.5 text-xs",
        blocking ? "text-destructive" : "text-warning",
      )}
      data-testid="publish-required-fields"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {!missing
            ? t("thread.publishPopover.requiredFieldsEmpty")
            : review
              ? t("thread.publishPopover.requiredFieldsMissingReview")
              : t("thread.publishPopover.requiredFieldsMissing")}
        </span>
      </div>
      <ul className="space-y-1 pl-5.5">
        {listed.slice(0, LISTED_CHANGES).map(({ change, fields }) => {
          // Missing fields first: they are the ones that stop a Publish.
          const ordered = [...fields].sort(
            (a, b) => Number(b.blocks) - Number(a.blocks),
          );
          return (
            <li key={changeId(change)}>
              <span className="font-medium">{change.name}</span>
              {": "}
              {[
                ...ordered.slice(0, LISTED_FIELDS).map(requiredFieldLabel),
                more(ordered.length - LISTED_FIELDS),
              ]
                .filter(Boolean)
                .join(", ")}
            </li>
          );
        })}
        {found.length > LISTED_CHANGES ? (
          <li>{more(found.length - LISTED_CHANGES)}</li>
        ) : null}
      </ul>
    </div>
  );
}

import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { useT } from "@/i18n/use-t.ts";

/**
 * The pull request drafts switch (`metadata.pullRequestDrafts`). Layered on
 * Fast Preview like {@link InPlaceRenderField}: a pull request draft is a CMS
 * session, so the parent shows this only while Fast Preview is on.
 */
export function PullRequestDraftsField<T extends FieldValues>({
  control,
}: {
  control: Control<T>;
}) {
  const t = useT();
  return (
    <Controller
      control={control}
      name={"metadata.pullRequestDrafts" as FieldPath<T>}
      render={({ field }) => (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label
              htmlFor="pull-request-drafts"
              className="font-normal text-foreground"
            >
              {t("sandbox.cmsSettings.pullRequestDrafts.label")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("sandbox.cmsSettings.pullRequestDrafts.description")}
            </p>
          </div>
          <Switch
            id="pull-request-drafts"
            className="shrink-0"
            checked={!!field.value}
            onCheckedChange={(checked) => field.onChange(checked)}
          />
        </div>
      )}
    />
  );
}

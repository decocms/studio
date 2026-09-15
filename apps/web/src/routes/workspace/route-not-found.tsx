import { useT } from "@/i18n/use-t";

/** A route-local invalid-payload state that keeps the workspace chrome mounted. */
export function RouteNotFound() {
  const t = useT();

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex max-w-xs flex-col items-center gap-2 text-center">
        <h2 className="text-base font-medium text-foreground">
          {t("common.index.pageNotFound")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("common.index.pageNotFoundDescription")}
        </p>
      </div>
    </div>
  );
}

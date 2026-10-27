import { useState } from "react";
import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
  useWatch,
} from "react-hook-form";
import { Plus, Trash01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { RUNTIME_APPS_MAX, type RuntimeApp } from "@decocms/shared/sdk/types";
import { useT } from "@/i18n/use-t.ts";
import { normalizeAppPath } from "@/components/sandbox/preview/app-preview-url";

export interface RuntimeAppsFieldProps<T extends FieldValues> {
  control: Control<T>;
}

/**
 * The other apps of a monorepo the site editor previews beside the one at
 * `metadata.runtime.path`. Same `FieldPath<T>` cast contract as
 * `RuntimeFields`.
 */
export function RuntimeAppsField<T extends FieldValues>({
  control,
}: RuntimeAppsFieldProps<T>) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mainPath = normalizeAppPath(
    (useWatch({
      control,
      name: "metadata.runtime.path" as FieldPath<T>,
    }) as string | null | undefined) ?? "",
  );

  return (
    <Controller
      control={control}
      name={"metadata.runtime.apps" as FieldPath<T>}
      render={({ field }) => {
        const apps = (field.value ?? []) as RuntimeApp[];
        const setApps = (next: RuntimeApp[]) =>
          field.onChange(next.length ? next : null);

        const commitDraft = () => {
          if (draft === null) return;
          const path = normalizeAppPath(draft);
          if (!path) {
            setDraft(null);
            setError(null);
            return;
          }
          if (path === mainPath || apps.some((app) => app.path === path)) {
            setError(t("sandbox.runtimeApps.duplicate"));
            return;
          }
          setApps([...apps, { path }]);
          setDraft(null);
          setError(null);
        };

        return (
          <div className="space-y-2">
            <Label htmlFor="runtime-apps-draft">
              {t("sandbox.runtimeApps.title")}
            </Label>
            {apps.length > 0 && (
              <ul className="space-y-1.5">
                {apps.map((app) => (
                  <li
                    key={app.path}
                    className="flex h-9 items-center gap-2 rounded-md border border-border px-3"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {app.path}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("sandbox.runtimeApps.remove", {
                        path: app.path,
                      })}
                      onClick={() =>
                        setApps(apps.filter((a) => a.path !== app.path))
                      }
                    >
                      <Trash01 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {draft !== null ? (
              <Input
                id="runtime-apps-draft"
                autoFocus
                placeholder="apps/checkout"
                value={draft}
                aria-invalid={!!error}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitDraft();
                  } else if (e.key === "Escape") {
                    setDraft(null);
                    setError(null);
                  }
                }}
              />
            ) : (
              apps.length < RUNTIME_APPS_MAX && (
                <Button
                  id="runtime-apps-draft"
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDraft("")}
                >
                  <Plus />
                  {t("sandbox.runtimeApps.add")}
                </Button>
              )
            )}
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("sandbox.runtimeApps.description", {
                  max: String(RUNTIME_APPS_MAX),
                })}
              </p>
            )}
          </div>
        );
      }}
    />
  );
}

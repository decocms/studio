import { useRef } from "react";
import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { useT } from "@/i18n/use-t.ts";
import { PACKAGE_MANAGER_CONFIG } from "@decocms/shared/runtime-defaults";
import type { PackageManager } from "@decocms/shared/runtime-defaults";
import { parsePortInput } from "./parse-port";

const PACKAGE_MANAGERS = Object.keys(
  PACKAGE_MANAGER_CONFIG,
) as PackageManager[];
const NONE_VALUE = "__none__";

// Generic over the parent form schema so callers pass `form.control` without
// casting. The `metadata.runtime.{selected,port,path}` field paths are
// asserted via `FieldPath<T>` casts at each Controller — the runtime contract
// is the literal path string, and the cast keeps that contract contained to
// this leaf component.
export interface RuntimeFieldsProps<T extends FieldValues> {
  control: Control<T>;
}

export function RuntimeFields<T extends FieldValues>({
  control,
}: RuntimeFieldsProps<T>) {
  const t = useT();
  // `useRef` lives in the component body (not inside `Controller`'s `render`
  // callback) to comply with the Rules of Hooks — `render` is a function
  // invoked during render, so calling hooks from there is forbidden.
  const portInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="runtime-pm">
          {t("sandbox.runtimeFields.packageManager")}
        </Label>
        <Controller
          control={control}
          name={"metadata.runtime.selected" as FieldPath<T>}
          render={({ field }) => (
            <Select
              value={field.value ?? NONE_VALUE}
              onValueChange={(v) => field.onChange(v === NONE_VALUE ? null : v)}
            >
              <SelectTrigger id="runtime-pm">
                <SelectValue
                  placeholder={t("sandbox.runtimeFields.autoDetect")}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>
                  {t("sandbox.runtimeFields.autoDetect")}
                </SelectItem>
                {PACKAGE_MANAGERS.map((pm) => (
                  <SelectItem key={pm} value={pm}>
                    {pm}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="runtime-path">
          {t("sandbox.runtimeFields.packagePath")}
        </Label>
        <Controller
          control={control}
          name={"metadata.runtime.path" as FieldPath<T>}
          render={({ field }) => (
            <Input
              id="runtime-path"
              placeholder="."
              // Uncontrolled like the port field — write on blur, normalize
              // empty to null. The daemon reads this as
              // `application.packageManager.path` and uses it as the cwd for
              // install + dev script.
              defaultValue={field.value ?? ""}
              onBlur={(e) => {
                const v = e.target.value.trim();
                field.onChange(v === "" ? null : v);
              }}
            />
          )}
        />
        <p className="text-xs text-muted-foreground">
          {t("sandbox.runtimeFields.packagePathDescription")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="runtime-port">
          {t("sandbox.runtimeFields.devServerPort")}
        </Label>
        <Controller
          control={control}
          name={"metadata.runtime.port" as FieldPath<T>}
          render={({ field }) => (
            <Input
              ref={portInputRef}
              id="runtime-port"
              inputMode="numeric"
              placeholder={t("sandbox.runtimeFields.auto")}
              // Uncontrolled (defaultValue + onBlur). parsePortInput rejects
              // invalid; we only commit on blur if the parser is happy. This
              // avoids a controlled-input UX where invalid keystrokes reset
              // the displayed value.
              defaultValue={field.value ?? ""}
              onBlur={(e) => {
                const result = parsePortInput(e.target.value);
                if (result.ok) {
                  field.onChange(result.value);
                } else if (portInputRef.current) {
                  // Snap back to the last good value so the rejection is visible.
                  portInputRef.current.value = field.value ?? "";
                }
              }}
            />
          )}
        />
        <p className="text-xs text-muted-foreground">
          {t("sandbox.runtimeFields.devServerPortDescription")}
        </p>
      </div>
    </div>
  );
}

import { useRef } from "react";
import { Controller, type Control } from "react-hook-form";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { PACKAGE_MANAGER_CONFIG } from "@/shared/runtime-defaults";
import type { PackageManager } from "@/shared/runtime-defaults";
import { parsePortInput } from "./parse-port";

const PACKAGE_MANAGERS = Object.keys(
  PACKAGE_MANAGER_CONFIG,
) as PackageManager[];
const NONE_VALUE = "__none__";

// `Control<unknown>` keeps the component reusable from any parent form whose
// schema includes `metadata.runtime.{selected, port}`.
export interface RuntimeFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: parent form types vary; the field paths are stable
  control: Control<any>;
}

export function RuntimeFields({ control }: RuntimeFieldsProps) {
  // `useRef` lives in the component body (not inside `Controller`'s `render`
  // callback) to comply with the Rules of Hooks — `render` is a function
  // invoked during render, so calling hooks from there is forbidden.
  const portInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="runtime-pm">Package manager</Label>
        <Controller
          control={control}
          name="metadata.runtime.selected"
          render={({ field }) => (
            <Select
              value={field.value ?? NONE_VALUE}
              onValueChange={(v) => field.onChange(v === NONE_VALUE ? null : v)}
            >
              <SelectTrigger id="runtime-pm">
                <SelectValue placeholder="Auto-detect" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>Auto-detect</SelectItem>
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
        <Label htmlFor="runtime-path">Package path</Label>
        <Controller
          control={control}
          name="metadata.runtime.path"
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
          Path (relative to repo root) to the directory containing package.json.
          Leave blank for the repo root.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="runtime-port">Dev server port</Label>
        <Controller
          control={control}
          name="metadata.runtime.port"
          render={({ field }) => (
            <Input
              ref={portInputRef}
              id="runtime-port"
              inputMode="numeric"
              placeholder="Auto"
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
          Leave blank to let the runner pick.
        </p>
      </div>
    </div>
  );
}

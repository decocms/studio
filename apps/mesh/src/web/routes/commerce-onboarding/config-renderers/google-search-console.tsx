import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Loading01 } from "@untitledui/icons";
import { useState } from "react";
import type { CompanionConfigRendererProps } from "./types.ts";

export function GoogleSearchConsoleRenderer({
  currentValue,
  verifiedSites,
  saving,
  error,
  onSave,
}: CompanionConfigRendererProps) {
  const saved = (currentValue.siteUrl as string | undefined) ?? "";
  const [value, setValue] = useState(saved);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-1 items-center gap-2">
        {verifiedSites.length > 0 ? (
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger size="sm" className="flex-1">
              <SelectValue placeholder="Select a verified site..." />
            </SelectTrigger>
            <SelectContent>
              {verifiedSites.map((s) => (
                <SelectItem key={s.siteUrl} value={s.siteUrl}>
                  {s.siteUrl}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sc-domain:example.com"
            className="flex-1"
          />
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!value || saving}
          onClick={() => onSave({ siteUrl: value })}
        >
          {saving ? <Loading01 size={16} className="animate-spin" /> : "Save"}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

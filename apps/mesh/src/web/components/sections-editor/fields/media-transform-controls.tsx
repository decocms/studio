import { useId } from "react";
import { DotsVertical } from "@untitledui/icons";
import { useT } from "@/web/i18n/use-t.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import {
  getMutedFromUrl,
  getQualityFromUrl,
  isQuality,
  QUALITY_OPTIONS,
  setMutedOnUrl,
  setQualityOnUrl,
} from "./media-url-params";

/**
 * CDN transform controls tucked behind a "⋮" popover next to the media actions:
 * a `quality` segmented control (images + video) and, for video, a `muted`
 * switch. Reads/writes the params directly on the URL string via
 * {@link media-url-params}, so the value the form persists stays a plain URL.
 */
export function MediaTransformControls({
  value,
  onChange,
  showMuted = false,
}: {
  value: string;
  onChange: (next: string) => void;
  showMuted?: boolean;
}) {
  const t = useT();
  const mutedId = useId();
  const quality = getQualityFromUrl(value);
  const muted = getMutedFromUrl(value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          aria-label={t(
            "sectionsEditor.mediaTransformControls.mediaOptionsLabel",
          )}
        >
          <DotsVertical size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto min-w-52 p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">
              {t("sectionsEditor.mediaTransformControls.qualityLabel")}
            </Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={quality ?? ""}
              // Radix single-select yields "" when the active item is toggled
              // off — map that back to "no quality param".
              onValueChange={(q) =>
                onChange(setQualityOnUrl(value, isQuality(q) ? q : undefined))
              }
            >
              {QUALITY_OPTIONS.map((opt) => (
                <ToggleGroupItem
                  key={opt}
                  value={opt}
                  className="h-8 px-3 text-xs capitalize"
                >
                  {opt}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {showMuted && (
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor={mutedId}
                className="text-xs text-muted-foreground"
              >
                {t("sectionsEditor.mediaTransformControls.mutedLabel")}
              </Label>
              <Switch
                id={mutedId}
                checked={muted}
                onCheckedChange={(v) => onChange(setMutedOnUrl(value, v))}
              />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

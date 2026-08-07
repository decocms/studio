import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { SeoTypeOption } from "./seo-schema";

interface SeoTypeSelectProps {
  options: SeoTypeOption[];
  value: string;
  onChange: (resolveType: string) => void;
}

export function SeoTypeSelect({
  options,
  value,
  onChange,
}: SeoTypeSelectProps) {
  const t = useT();
  if (options.length <= 1) return null;

  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">
        {t("sectionsEditor.seoTypeSelect.label")}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={t("sectionsEditor.seoTypeSelect.placeholder")}
          />
        </SelectTrigger>
        <SelectContent>
          {options
            .filter((option) => option.resolveType.length > 0)
            .map((option) => (
              <SelectItem key={option.resolveType} value={option.resolveType}>
                {option.title}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

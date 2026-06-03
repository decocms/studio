import { Label } from "@deco/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
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
  if (options.length <= 1) return null;

  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">SEO type</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select SEO type" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.resolveType} value={option.resolveType}>
              {option.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

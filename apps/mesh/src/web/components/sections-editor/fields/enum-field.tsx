import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import type { FieldProps } from "./field-props";

export function EnumField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const options = schema.enum ?? [];
  const strValue = value != null ? String(value) : "";

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label htmlFor={path}>{label}</Label>
        {schema.description && (
          <p className="text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
      </div>
      <Select
        value={strValue}
        onValueChange={(v) => {
          const original = options.find((opt) => String(opt) === v);
          onChange(original !== undefined ? original : v);
        }}
      >
        <SelectTrigger className="h-10">
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={String(opt)} value={String(opt)}>
              {String(opt)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

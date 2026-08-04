import { useT } from "@/i18n/use-t.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import type { FieldProps } from "./field-props";
import {
  enumOptionLabel,
  enumOptionToSelectValue,
  formValueToSelectValue,
  selectValueToEnumOption,
} from "./enum-select-value";
import { FieldLabel } from "./field-label";

export function EnumField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const t = useT();
  const options = schema.enum ?? [];
  const selectValue = formValueToSelectValue(value, options);

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
      />
      <Select
        value={selectValue}
        onValueChange={(v) => onChange(selectValueToEnumOption(v, options))}
      >
        <SelectTrigger className="h-10">
          <SelectValue
            placeholder={t("sectionsEditor.enumField.selectPlaceholder")}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => {
            const itemValue = enumOptionToSelectValue(opt);
            return (
              <SelectItem key={itemValue} value={itemValue}>
                {enumOptionLabel(opt)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

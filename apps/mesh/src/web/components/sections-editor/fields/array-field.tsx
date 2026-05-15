import { Button } from "@deco/ui/components/button.tsx";
import { Plus, Trash01 } from "@untitledui/icons";
import type { FieldProps } from "./field-props";
import { SchemaForm } from "../schema-form";
import { renderField } from "../schema-form";

export function ArrayField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = schema.items;

  const addItem = () => {
    const defaultVal =
      itemSchema?.type === "object" ? {} : (itemSchema?.default ?? "");
    onChange([...items, defaultVal]);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, val: unknown) => {
    const next = [...items];
    next[index] = val;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="outline" size="sm" onClick={addItem}>
          <Plus size={14} />
          Add
        </Button>
      </div>
      {schema.description && (
        <p className="text-xs text-muted-foreground">{schema.description}</p>
      )}
      {items.map((item, i) => (
        <div key={`${path}.${i}`} className="border rounded-md p-3 relative">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute top-1 right-1 h-7 w-7 p-0"
            onClick={() => removeItem(i)}
          >
            <Trash01 size={14} />
          </Button>
          {itemSchema?.type === "object" && itemSchema.properties ? (
            <SchemaForm
              schema={itemSchema}
              value={item}
              onChange={(val) => updateItem(i, val)}
              basePath={`${path}.${i}`}
            />
          ) : itemSchema ? (
            renderField({
              schema: itemSchema,
              value: item,
              onChange: (val) => updateItem(i, val),
              path: `${path}.${i}`,
              label: itemSchema.title ?? `Item ${i + 1}`,
            })
          ) : null}
        </div>
      ))}
      {items.length === 0 && (
        <p className="text-xs text-muted-foreground py-2">No items yet.</p>
      )}
    </div>
  );
}

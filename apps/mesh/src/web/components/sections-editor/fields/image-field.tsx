import { useState } from "react";
import { Image01, Upload01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { FilePickerDialog } from "@/web/components/file-picker/file-picker-dialog";
import type { FieldProps } from "./field-props";

/**
 * Extract a URL string from values that may be plain strings OR deco's
 * multivariate flag wrapper object (`{ __resolveType, variants: [...] }`).
 * Saving back always writes a plain string — deco resolves plain strings
 * at render time, and multi-variant editing isn't part of this UI.
 */
function extractUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.variants)) {
    const variants = obj.variants as Array<{
      rule?: { __resolveType?: string };
      value?: unknown;
    }>;
    const always = variants.find((v) =>
      v.rule?.__resolveType?.includes("always"),
    );
    if (typeof always?.value === "string") return always.value;
    const first = variants.find((v) => typeof v.value === "string");
    if (first) return first.value as string;
  }
  if (typeof obj.src === "string") return obj.src;
  if (typeof obj.url === "string") return obj.url;
  if (typeof obj.value === "string") return obj.value;
  return "";
}

export function ImageField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const strValue = extractUrl(value);
  const [pickerOpen, setPickerOpen] = useState(false);

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
      {strValue ? (
        <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/30">
          <img
            src={strValue}
            alt={label}
            className="max-h-32 w-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).parentElement!.style.display =
                "none";
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/30 py-6 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground transition"
        >
          <Image01 size={16} />
          <span>Pick or upload an image</span>
        </button>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={path}
          type="url"
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://..."
          className="h-10 flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
          className="h-10 shrink-0"
        >
          <Upload01 size={14} />
          {strValue ? "Replace" : "Browse"}
        </Button>
      </div>
      <FilePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="image"
        onSelect={(url) => onChange(url)}
      />
    </div>
  );
}

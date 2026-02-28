import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type FormField = { label: string; value: string };
type FormResultArgs = {
  fields?: FormField[];
  title?: string;
  success?: boolean;
};

export default function FormResult() {
  const { args } = useWidget<FormResultArgs>();

  if (!args) return null;

  const { fields = [], title = "Form Result", success = true } = args;

  return (
    <div className="p-4 font-sans">
      <div className="flex items-center gap-2 mb-3">
        <div
          className={cn(
            "size-5 rounded-full flex items-center justify-center text-xs",
            success ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700",
          )}
        >
          {success ? "✓" : "✕"}
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </div>
      {fields.length > 0 && (
        <dl className="space-y-1.5">
          {fields.map((field, i) => (
            <div key={i} className="flex gap-2 text-sm">
              <dt className="text-muted-foreground shrink-0 min-w-24">
                {field.label}
              </dt>
              <dd className="text-foreground font-medium break-all">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

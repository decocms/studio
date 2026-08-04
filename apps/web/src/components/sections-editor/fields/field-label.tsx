import { HelpCircle } from "@untitledui/icons";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";

export function FieldDescriptionTooltip({
  description,
}: {
  description: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label={description}
        >
          <HelpCircle className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{description}</TooltipContent>
    </Tooltip>
  );
}

type FieldLabelProps = Readonly<{
  htmlFor: string;
  label: string;
  description?: string;
  labelClassName?: string;
}>;

export function FieldLabel({
  htmlFor,
  label,
  description,
  labelClassName,
}: FieldLabelProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} className={labelClassName}>
        {label}
      </Label>
      {description && <FieldDescriptionTooltip description={description} />}
    </div>
  );
}

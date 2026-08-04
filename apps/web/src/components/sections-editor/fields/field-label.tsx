import { cloneElement, type ReactElement } from "react";
import { Label } from "@deco/ui/components/label.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { useOrgFlag } from "@/hooks/use-organization-settings";

const DESCRIPTION_AFFORDANCE_CLASS =
  "cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4";

/**
 * Whether the blocks form shows a field's description as a hover tooltip on
 * its title, instead of the default inline text below the title — an
 * opt-in org-level preference (Settings → Blocks form).
 */
export function useFieldDescriptionTooltips(): boolean {
  return useOrgFlag("field_description_tooltips");
}

/**
 * Wraps `children` in a hover tooltip revealing `description`, marking it
 * with a dotted-underline affordance so it still reads as hoverable now that
 * there's no separate help icon. Renders `children` unchanged when there's
 * no description, or when the org hasn't opted into tooltip descriptions
 * (callers render the description themselves, inline, in that case).
 */
export function FieldDescriptionTooltip({
  description,
  children,
}: {
  description?: string;
  children: ReactElement<{ className?: string }>;
}) {
  const tooltipsEnabled = useFieldDescriptionTooltips();
  if (!description || !tooltipsEnabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {cloneElement(children, {
          className: cn(children.props.className, DESCRIPTION_AFFORDANCE_CLASS),
        })}
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
  const tooltipsEnabled = useFieldDescriptionTooltips();
  if (!tooltipsEnabled) {
    return (
      <div className="space-y-0.5">
        <Label htmlFor={htmlFor} className={labelClassName}>
          {label}
        </Label>
        {description && (
          <p className="text-xs leading-normal text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    );
  }
  return (
    <FieldDescriptionTooltip description={description}>
      <Label htmlFor={htmlFor} className={labelClassName}>
        {label}
      </Label>
    </FieldDescriptionTooltip>
  );
}

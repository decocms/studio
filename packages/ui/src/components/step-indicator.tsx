import { Check } from "@untitledui/icons";

import { cn } from "../lib/utils.ts";

interface Step {
  id: string;
  label: string;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: number;
  visited?: Set<number>;
  onStepClick?: (index: number) => void;
}

export function StepIndicator({
  steps,
  currentStep,
  visited,
  onStepClick,
}: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-0">
      {steps.map((step, index) => {
        const isCompleted = index < currentStep;
        const isCurrent = index === currentStep;
        const isClickable =
          onStepClick && (visited?.has(index) || index <= currentStep);

        return (
          <div key={step.id} className="flex items-center">
            <button
              type="button"
              onClick={() => isClickable && onStepClick?.(index)}
              disabled={!isClickable}
              className={cn(
                "flex items-center gap-(--space-xs) rounded-xs focus-ring",
                isClickable && "cursor-pointer",
                !isClickable && "cursor-default",
              )}
            >
              <div
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-xs font-medium transition-[background-color,color,box-shadow] duration-(--motion-duration) ease-motion",
                  isCompleted && "bg-primary text-primary-foreground",
                  isCurrent &&
                    "bg-primary text-primary-foreground shadow-[0_0_0_var(--border-l)_var(--neutral-4)]",
                  !isCompleted &&
                    !isCurrent &&
                    "bg-muted text-muted-foreground",
                )}
              >
                {isCompleted ? <Check size={14} /> : index + 1}
              </div>
              <span
                className={cn(
                  "text-s font-medium",
                  isCurrent && "text-foreground",
                  !isCurrent && "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </button>
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "mx-(--space-s) h-px w-8",
                  index < currentStep ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The A/B split drawn as a donut ("pizza") with a slider per side: the one
 * way Studio shows and edits how visitors are split. The Experiments tab of a
 * v7 site (`SplitCard`, one slider per variant) and a Blocks (v8) site's test
 * (`ShareSplit`, one share: in the test or not) both draw it, so the two read
 * the same. Percentages are moved, never typed.
 */

import type { CSSProperties } from "react";
import { Cell, Pie, PieChart } from "recharts";
import { Slider } from "@decocms/ui/components/slider.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";

/** Control is a quiet neutral; each treatment gets its own hue. */
export const PRIMARY_COLOR = "var(--color-primary)";
const TREATMENT_COLORS = [
  PRIMARY_COLOR,
  "var(--color-chart-1)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
];
export const CONTROL_COLOR =
  "color-mix(in oklch, var(--color-muted-foreground) 45%, transparent)";

export function armColors(arms: { role?: string | null }[]): string[] {
  let treatment = 0;
  return arms.map((a) =>
    a.role === "control"
      ? CONTROL_COLOR
      : (TREATMENT_COLORS[treatment++ % TREATMENT_COLORS.length] as string),
  );
}

export interface DonutArm {
  id: string;
  role?: string | null;
  weight: number;
}

export function SplitDonut({
  arms,
  size,
  thickness,
}: {
  arms: DonutArm[];
  size: number;
  thickness: number;
}) {
  const colors = armColors(arms);
  const outer = size / 2;
  return (
    <PieChart width={size} height={size}>
      <Pie
        data={arms.map((a) => ({ id: a.id, value: a.weight }))}
        dataKey="value"
        nameKey="id"
        innerRadius={outer - thickness}
        outerRadius={outer}
        startAngle={90}
        endAngle={450}
        paddingAngle={arms.filter((a) => a.weight > 0).length > 1 ? 2 : 0}
        cornerRadius={thickness / 4}
        stroke="none"
        isAnimationActive={false}
      >
        {arms.map((a, i) => (
          <Cell key={a.id} fill={colors[i]} />
        ))}
      </Pie>
    </PieChart>
  );
}

/** A whole percentage from 0 to 100. */
export function clampShare(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** A v8 test's share as the donut's two sides: in the test, and the rest. */
export function shareArms(share: number): DonutArm[] {
  const inTest = clampShare(share);
  return [
    { id: "in-test", role: "treatment", weight: inTest },
    { id: "rest", role: "control", weight: 100 - inTest },
  ];
}

/** One side's swatch and words, with its percentage. */
function Side({
  color,
  label,
  value,
  testId,
}: {
  color: string;
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className="size-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-medium tabular-nums" data-testid={testId}>
        {value}%
      </span>
    </div>
  );
}

/**
 * A Blocks (v8) test's one number, the share of visitors in the test, edited
 * with a slider over the donut: the in-test side in the primary colour, the
 * rest in the control's neutral. Arrow keys move it by 1, Page Up/Down by 10,
 * Home/End to 0 and 100 (the slider's own keys). `onChange` fires while it
 * moves; `onCommit` once it settles (pointer released, key pressed).
 */
export function ShareSplit({
  value,
  onChange,
  onCommit,
  sliderLabel,
  inTestLabel,
  restLabel,
  centerLabel,
  disabled,
  compact,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  /** The slider's accessible name. */
  sliderLabel: string;
  /** "See the test", beside the in-test share. */
  inTestLabel: string;
  /** "See the page as it is", beside the rest. */
  restLabel: string;
  /** Under the percentage in the donut's hole. */
  centerLabel: string;
  disabled?: boolean;
  /** The smaller donut, for a dialog. */
  compact?: boolean;
  className?: string;
}) {
  const share = clampShare(value);
  const arms = shareArms(share);
  const [inColor, restColor] = armColors(arms) as [string, string];
  const size = compact ? 112 : 176;
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-6 sm:flex-row",
        compact && "gap-4",
        className,
      )}
      data-testid="share-split"
    >
      <div className="relative flex-shrink-0" aria-hidden="true">
        <SplitDonut arms={arms} size={size} thickness={compact ? 14 : 22} />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={cn(
              "font-medium tabular-nums",
              compact ? "text-xl" : "text-3xl",
            )}
          >
            {share}%
          </span>
          <span className="text-xs text-muted-foreground">{centerLabel}</span>
        </div>
      </div>
      <div className="flex w-full min-w-0 flex-1 flex-col gap-3">
        <Side
          color={inColor}
          label={inTestLabel}
          value={share}
          testId="share-split-in"
        />
        <Slider
          value={[share]}
          min={0}
          max={100}
          step={1}
          disabled={disabled}
          thumbLabel={sliderLabel}
          thumbValueText={`${share}%`}
          onValueChange={([next]) => onChange(clampShare(next ?? 0))}
          onValueCommit={([next]) => onCommit?.(clampShare(next ?? 0))}
          style={
            inColor === PRIMARY_COLOR
              ? undefined
              : ({ "--primary": inColor } as CSSProperties)
          }
        />
        <Side
          color={restColor}
          label={restLabel}
          value={100 - share}
          testId="share-split-rest"
        />
      </div>
    </div>
  );
}

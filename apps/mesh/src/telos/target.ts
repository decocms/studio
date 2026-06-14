// The org's first goal — measurable from Mesh's own data.
export interface OnboardingTarget {
  title: string;
  metric: "connections" | "automations_run";
  targetValue: number;
}

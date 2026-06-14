// The org's first goal — deliberately measurable from Mesh's own data (the world
// a future Eudaimon would observe: connections made, automations run, …).
export interface OnboardingTarget {
  title: string;
  metric: "connections" | "automations_run";
  targetValue: number;
}

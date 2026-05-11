export type DrawerStatus =
  | "idle"
  | "starting"
  | "running"
  | "suspended"
  | "errored";

export function sandboxStatusClass(status: DrawerStatus): string {
  switch (status) {
    case "idle":
      return "bg-muted text-muted-foreground";
    case "starting":
      return "bg-purple-500/15 text-purple-700";
    case "running":
      return "bg-emerald-500/15 text-emerald-700";
    case "suspended":
      return "bg-blue-500/15 text-blue-700";
    case "errored":
      return "bg-destructive/15 text-destructive";
  }
}

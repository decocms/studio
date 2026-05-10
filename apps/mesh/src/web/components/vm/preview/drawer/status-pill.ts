export type DrawerStatus =
  | "idle"
  | "starting"
  | "running"
  | "suspended"
  | "errored";

export function statusPillFor(status: DrawerStatus): {
  className: string;
  label: string;
} {
  switch (status) {
    case "idle":
      return { className: "bg-muted text-muted-foreground", label: "stopped" };
    case "starting":
      return {
        className: "bg-amber-500/15 text-amber-700",
        label: "starting",
      };
    case "running":
      return {
        className: "bg-emerald-500/15 text-emerald-700",
        label: "running",
      };
    case "suspended":
      return {
        className: "bg-blue-500/15 text-blue-700",
        label: "suspended",
      };
    case "errored":
      return {
        className: "bg-destructive/15 text-destructive",
        label: "error",
      };
  }
}

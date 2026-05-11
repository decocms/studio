import type { DrawerStatus } from "./status-pill";

export interface MenuItem {
  label: "Start" | "Stop" | "Restart" | "Resume" | "Retry";
  action: "start" | "stop" | "restart" | "resume" | "retry";
}

/**
 * Items the status split-button's dropdown menu shows for each drawer
 * state. Mirrors the per-status action buttons the old DrawerHeader
 * rendered inline; `errored` adds a new "Retry" entry that wires to the
 * same retryAutoStart handler the booting overlay uses.
 *
 * Order matters — the menu renders items in array order.
 */
export function menuItemsFor(status: DrawerStatus): MenuItem[] {
  switch (status) {
    case "idle":
      return [{ label: "Start", action: "start" }];
    case "starting":
    case "running":
      // Stop + Restart live on the setup tab's right-side controls, not in
      // the Sandbox split-button menu. Returning [] hides the chevron half.
      return [];
    case "suspended":
      return [{ label: "Resume", action: "resume" }];
    case "errored":
      return [{ label: "Retry", action: "retry" }];
  }
}

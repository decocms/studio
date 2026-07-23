/** Pure mapping from a keypress to an interaction intent. */

export type LinkIntent =
  | { type: "move"; delta: 1 | -1 }
  | { type: "stop" }
  | { type: "delete" }
  | { type: "open" }
  | { type: "quit" }
  | { type: "confirmYes" }
  | { type: "confirmNo" };

export interface KeyState {
  upArrow?: boolean;
  downArrow?: boolean;
  ctrl?: boolean;
}

export function keyToIntent(
  input: string,
  key: KeyState,
  pendingConfirm: boolean,
): LinkIntent | null {
  if (pendingConfirm) {
    return input === "y" || input === "Y"
      ? { type: "confirmYes" }
      : { type: "confirmNo" };
  }
  if (key.upArrow || input === "k") return { type: "move", delta: -1 };
  if (key.downArrow || input === "j") return { type: "move", delta: 1 };
  if (input === "s") return { type: "stop" };
  if (input === "d") return { type: "delete" };
  if (input === "o") return { type: "open" };
  if (input === "q" || (key.ctrl === true && input === "c")) {
    return { type: "quit" };
  }
  return null;
}

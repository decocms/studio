/**
 * One-shot handoff for actions that originate in the Preview tab but must be
 * applied by the freshly-mounted Blocks tab (a separate PreviewContent mount).
 * Set right before navigating to `?main=blocks`; consumed once on mount.
 */
export type PreviewTabIntent = { kind: "edit-seo"; pageKey: string } | null;

let pending: PreviewTabIntent = null;

export function setPreviewTabIntent(intent: PreviewTabIntent): void {
  pending = intent;
}

/** Returns the pending intent and clears it (one-shot). */
export function consumePreviewTabIntent(): PreviewTabIntent {
  const intent = pending;
  pending = null;
  return intent;
}

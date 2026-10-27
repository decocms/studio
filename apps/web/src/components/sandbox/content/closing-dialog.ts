import { useState } from "react";

/** A dialog's words: its title and description. */
export interface DialogWords {
  title: string;
  description: string;
}

/**
 * The words a dialog shows while it closes: kept as they were through the
 * fade (its subject is cleared to close it, and the change it made can turn
 * its description too), so its title never falls back to a default ("Delete
 * item?") as it fades out. `keep` false (anything but a hosted v8 draft):
 * exactly `words`, as before.
 */
export function useShownWhileClosing(
  words: DialogWords | null,
  keep: boolean,
): DialogWords | null {
  const [shown, setShown] = useState<DialogWords | null>(words);
  if (
    words !== null &&
    (words.title !== shown?.title || words.description !== shown?.description)
  ) {
    setShown(words);
  }
  return words ?? (keep ? shown : null);
}

const MAX_LISTED = 3;

/**
 * Human-readable list of the values an edit and the stored block both
 * changed, from their JSON pointers: `/slides/0/title` reads "slides › 1 ›
 * title" (positions counted from 1, as the editor shows them). Lists at most
 * three and counts the rest.
 */
export function describeConflictFields(pointers: string[]): string {
  const labels = [
    ...new Set(
      pointers.map((pointer) => {
        const parts = pointer
          .split("/")
          .slice(1)
          .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
          .map((part) =>
            /^\d+$/.test(part) ? String(Number(part) + 1) : part,
          );
        return parts.length > 0 ? parts.join(" › ") : "*";
      }),
    ),
  ];
  const shown = labels.slice(0, MAX_LISTED).join(", ");
  const rest = labels.length - MAX_LISTED;
  return rest > 0 ? `${shown} (+${rest})` : shown;
}

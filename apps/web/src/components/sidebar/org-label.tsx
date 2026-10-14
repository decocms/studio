/**
 * Whose sidebar this is — the organization's mark and its name.
 *
 * It replaces the picker that used to sit here. A picker is a control, and
 * this had nothing left to control: switching organization is the rail on the
 * left, opening a project is the tree below, and creating either has its own
 * `+`. What was left was a chevron that opened a list to do what two things
 * already do better, on the one strip that should just say where you are.
 *
 * Deliberately not a button: nothing happens when you press a label, and a
 * hover surface on it would promise otherwise.
 */

import { LAYOUT_TOUR_ANCHORS } from "@/components/layout-tour/anchors";
import { useProjectContext } from "@/sdk";

export function OrgLabel({ collapsed = false }: { collapsed?: boolean }) {
  const { org } = useProjectContext();

  if (collapsed) {
    return (
      <div
        className="flex items-center justify-center"
        title={org.name}
        data-tour={LAYOUT_TOUR_ANCHORS.switcher}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
          {org.name}
        </span>
      </div>
    );
  }

  return (
    <div
      /* `pl-2` is the rows' own padding and `md:h-[34px]` the collapse toggle's height, so the strip lines up with both. */
      className="flex min-w-0 flex-1 items-center py-1.5 pr-1.5 pl-2 md:h-[34px] md:py-0"
      data-tour={LAYOUT_TOUR_ANCHORS.switcher}
    >
      <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
        {org.name}
      </span>
    </div>
  );
}
